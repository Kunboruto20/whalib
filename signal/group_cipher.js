'use strict';

const crypto = require('crypto');
const { SenderKeyRecord } = require('./sender_key_record');
const Curve = require('./curve');
const protobuf = require('protobufjs');

const sign = (privKey, msg) => Curve.calculateSignature(privKey, msg);
const verifySignature = (pubKey, msg, sig) => Curve.verifySignature(pubKey, msg, sig);
const SIGNATURE_LENGTH = 64;
const CURRENT_VERSION = 3;

const senderKeyMsgRoot = protobuf.Root.fromJSON({
    nested: {
        SenderKeyMessage: {
            fields: {
                id: { type: 'uint32', id: 1 },
                iteration: { type: 'uint32', id: 2 },
                ciphertext: { type: 'bytes', id: 3 }
            }
        }
    }
});
const SenderKeyMessageProto = senderKeyMsgRoot.lookupType('SenderKeyMessage');

function deriveSecrets(input, salt, info) {
    const prk = crypto.createHmac('sha256', salt).update(input).digest();
    const infoBuffer = Buffer.from(info);
    let t = Buffer.alloc(0);
    const result = [];
    for (let i = 1; i <= 3; i++) {
        const hmac = crypto.createHmac('sha256', prk);
        hmac.update(Buffer.concat([t, infoBuffer, Buffer.from([i])]));
        t = hmac.digest();
        result.push(t);
    }
    return result;
}

function deriveSenderMessageKey(seed) {
    const derivative = deriveSecrets(seed, Buffer.alloc(32), 'WhisperGroup');
    const keys = Buffer.alloc(32);
    derivative[0].copy(keys, 0, 16, 32);
    derivative[1].copy(keys, 16, 0, 16);
    const iv = derivative[0].slice(0, 16);
    return { iv: Buffer.from(iv), cipherKey: Buffer.from(keys) };
}

class GroupCipher {
    constructor(senderKeyStore, senderKeyName) {
        this.senderKeyStore = senderKeyStore;
        this.senderKeyName = senderKeyName;
    }

    async encrypt(paddedPlaintext) {
        const record = await this.senderKeyStore.loadSenderKey(this.senderKeyName);
        if (!record || record.isEmpty()) {
            throw new Error('No sender key for: ' + this.senderKeyName);
        }

        const state = record.getState();
        const senderKeyId = state.getSenderKeyId();
        const currentIteration = state.getIteration();
        const targetIteration = currentIteration === 0 ? 0 : currentIteration + 1;
        const { seed, iteration } = this._getSenderKey(state, targetIteration);
        const { iv, cipherKey } = deriveSenderMessageKey(seed);
        const ciphertext = this._aesCbcEncrypt(cipherKey, iv, paddedPlaintext);

        const senderKeyMessage = this._buildSenderKeyMessage(senderKeyId, iteration, ciphertext);

        const signingKey = state.getSigningKeyPrivate();
        let resultMsg;
        if (signingKey) {
            const signature = sign(signingKey, senderKeyMessage);
            resultMsg = Buffer.concat([senderKeyMessage, signature]);
        } else {
            resultMsg = senderKeyMessage;
        }

        await this.senderKeyStore.storeSenderKey(this.senderKeyName, record);

        return resultMsg;
    }

    async decrypt(senderKeyMessageBytes) {
        const buf = Buffer.from(senderKeyMessageBytes);

        const { keyId, iteration, ciphertext, signedPortion } = this._parseSenderKeyMessage(buf);

        const record = await this.senderKeyStore.loadSenderKey(this.senderKeyName);
        if (!record || record.isEmpty()) {
            throw new Error('No sender key state for: ' + this.senderKeyName);
        }

        const state = record.getState(keyId);

        const sigPubKey = state.getSigningKeyPublic();
        if (sigPubKey && signedPortion) {
            const sig = buf.slice(buf.length - SIGNATURE_LENGTH);
            const valid = verifySignature(sigPubKey, signedPortion, sig);
            if (!valid) {
                throw new Error('Invalid signature on sender key message');
            }
        }

        const { seed } = this._getSenderKey(state, iteration);
        const { iv, cipherKey } = deriveSenderMessageKey(seed);
        const plaintext = this._aesCbcDecrypt(cipherKey, iv, ciphertext);

        await this.senderKeyStore.storeSenderKey(this.senderKeyName, record);

        return plaintext;
    }

    _getSenderKey(state, targetIteration) {
        let currentIteration = state.getIteration();
        let chainKey = state.getSeedChainKey();

        if (currentIteration > targetIteration) {
            if (state.messageKeys && state.messageKeys.has(targetIteration)) {
                const seed = state.messageKeys.get(targetIteration);
                state.messageKeys.delete(targetIteration);
                return { seed, iteration: targetIteration };
            }
            throw new Error(`Received message with old counter: ${currentIteration}, ${targetIteration}`);
        }

        if (targetIteration - currentIteration > 2000) {
            throw new Error('Over 2000 messages into the future!');
        }

        while (currentIteration < targetIteration) {
            const msgSeed = crypto.createHmac('sha256', chainKey).update(Buffer.from([0x01])).digest();
            if (!state.messageKeys) state.messageKeys = new Map();
            state.messageKeys.set(currentIteration, msgSeed);
            chainKey = crypto.createHmac('sha256', chainKey).update(Buffer.from([0x02])).digest();
            currentIteration++;
        }

        const msgSeed = crypto.createHmac('sha256', chainKey).update(Buffer.from([0x01])).digest();
        const nextChainKey = crypto.createHmac('sha256', chainKey).update(Buffer.from([0x02])).digest();

        state.chainKey = nextChainKey;
        state.iteration = currentIteration + 1;

        return { seed: msgSeed, iteration: currentIteration };
    }

    _buildSenderKeyMessage(keyId, iteration, ciphertext) {
        const version = (CURRENT_VERSION << 4 | CURRENT_VERSION) & 0xFF;
        const versionBuf = Buffer.from([version]);

        const protoPayload = SenderKeyMessageProto.encode(
            SenderKeyMessageProto.create({
                id: keyId,
                iteration: iteration,
                ciphertext: ciphertext
            })
        ).finish();

        return Buffer.concat([versionBuf, protoPayload]);
    }

    _parseSenderKeyMessage(buf) {
        const version = buf[0] >> 4;
        if (version < 3) {
            throw new Error(`Unsupported sender key message version: ${version}`);
        }

        let protoPayload;
        let signedPortion;
        if (buf.length > 1 + SIGNATURE_LENGTH) {
            protoPayload = buf.slice(1, buf.length - SIGNATURE_LENGTH);
            signedPortion = buf.slice(0, buf.length - SIGNATURE_LENGTH);
        } else {
            protoPayload = buf.slice(1);
            signedPortion = null;
        }

        const decoded = SenderKeyMessageProto.decode(protoPayload);

        return {
            version,
            keyId: decoded.id,
            iteration: decoded.iteration,
            ciphertext: Buffer.from(decoded.ciphertext),
            signedPortion
        };
    }

    _aesCbcEncrypt(key, iv, plaintext) {
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        return Buffer.concat([cipher.update(plaintext), cipher.final()]);
    }

    _aesCbcDecrypt(key, iv, ciphertext) {
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    }
}

module.exports = GroupCipher;
