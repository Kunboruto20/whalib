'use strict';

const crypto = require('crypto');
const { SenderKeyRecord } = require('./sender_key_record');
const Curve = require('./curve');
const protobuf = require('protobufjs');

const generateKeyPair = () => Curve.generateKeyPair();

const senderKeyDistMsgRoot = protobuf.Root.fromJSON({
    nested: {
        SenderKeyDistributionMessage: {
            fields: {
                id: { type: 'uint32', id: 1 },
                iteration: { type: 'uint32', id: 2 },
                chainKey: { type: 'bytes', id: 3 },
                signingKey: { type: 'bytes', id: 4 }
            }
        }
    }
});
const SenderKeyDistributionMessageProto = senderKeyDistMsgRoot.lookupType('SenderKeyDistributionMessage');

class GroupSessionBuilder {
    constructor(senderKeyStore) {
        this.senderKeyStore = senderKeyStore;
    }

    async createSession(senderKeyName) {
        let record = await this.senderKeyStore.loadSenderKey(senderKeyName);
        if (!record || record.isEmpty()) {
            record = record || new SenderKeyRecord();
            const senderKeyId = crypto.randomInt(0, 0x7FFFFFFF);
            const chainKey = crypto.randomBytes(32);
            const signingKeyPair = generateKeyPair();

            record.setSenderKeyState(
                senderKeyId,
                0,
                chainKey,
                signingKeyPair.pubKey,
                signingKeyPair.privKey
            );

            await this.senderKeyStore.storeSenderKey(senderKeyName, record);
        }

        const state = record.getState();
        return this._buildDistributionMessage(
            state.getSenderKeyId(),
            state.getIteration(),
            state.getSeedChainKey(),
            state.getSigningKeyPublic()
        );
    }

    async processDistributionMessage(senderKeyName, distributionMessage) {
        const { id, iteration, chainKey, signingKey } = this._parseDistributionMessage(distributionMessage);

        let record = await this.senderKeyStore.loadSenderKey(senderKeyName);
        if (!record) {
            record = new SenderKeyRecord();
        }

        record.addState(id, iteration, chainKey, signingKey, null);

        await this.senderKeyStore.storeSenderKey(senderKeyName, record);
    }

    _buildDistributionMessage(id, iteration, chainKey, signingKeyPublic) {
        const version = ((3 << 4) | 3) & 0xFF;
        const versionBuf = Buffer.from([version]);

        const protoPayload = SenderKeyDistributionMessageProto.encode(
            SenderKeyDistributionMessageProto.create({
                id: id,
                iteration: iteration,
                chainKey: chainKey,
                signingKey: signingKeyPublic
            })
        ).finish();

        return Buffer.concat([versionBuf, protoPayload]);
    }

    _parseDistributionMessage(buf) {
        buf = Buffer.from(buf);

        const version = buf[0] >> 4;
        if (version < 3) {
            throw new Error(`Unsupported distribution message version: ${version}`);
        }

        const protoPayload = buf.slice(1);
        const decoded = SenderKeyDistributionMessageProto.decode(protoPayload);

        return {
            id: decoded.id,
            iteration: decoded.iteration,
            chainKey: Buffer.from(decoded.chainKey),
            signingKey: Buffer.from(decoded.signingKey)
        };
    }
}

module.exports = GroupSessionBuilder;
