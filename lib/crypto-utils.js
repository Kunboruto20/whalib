'use strict';

const nodeCrypto = require('crypto');
const curveLib = require('../signal/curve');

const KEY_BUNDLE_TYPE = Buffer.from([5]);

const generateSignalPubKey = (pubKey) => {
    if (pubKey.length === 33) return pubKey;
    return Buffer.concat([KEY_BUNDLE_TYPE, pubKey]);
};

const Curve = {
    generateKeyPair() {
        const { pubKey, privKey } = curveLib.generateKeyPair();
        return {
            private: Buffer.from(privKey),
            public: Buffer.from(pubKey.slice(1))
        };
    },
    sharedKey(privateKey, publicKey) {
        const shared = curveLib.calculateAgreement(generateSignalPubKey(publicKey), privateKey);
        return Buffer.from(shared);
    },
    sign(privateKey, buf) {
        return curveLib.calculateSignature(privateKey, buf);
    },
    verify(pubKey, message, signature) {
        try {
            curveLib.verifySignature(generateSignalPubKey(pubKey), message, signature);
            return true;
        } catch (e) {
            return false;
        }
    }
};

const signedKeyPair = (identityKeyPair, keyId) => {
    const preKey = Curve.generateKeyPair();
    const pubKey = generateSignalPubKey(preKey.public);
    const signature = Curve.sign(identityKeyPair.private, pubKey);
    return { keyPair: preKey, signature, keyId };
};

function aesEncryptGCM(plaintext, key, iv, additionalData) {
    const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(additionalData);
    return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function aesDecryptGCM(ciphertext, key, iv, additionalData) {
    const enc = ciphertext.slice(0, ciphertext.length - 16);
    const tag = ciphertext.slice(ciphertext.length - 16);
    const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(additionalData);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]);
}

function aesEncryptCTR(plaintext, key, iv) {
    const cipher = nodeCrypto.createCipheriv('aes-256-ctr', key, iv);
    return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aesDecryptCTR(ciphertext, key, iv) {
    const decipher = nodeCrypto.createDecipheriv('aes-256-ctr', key, iv);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function aesDecrypt(buffer, key) {
    return aesDecryptWithIV(buffer.slice(16), key, buffer.slice(0, 16));
}

function aesDecryptWithIV(buffer, key, iv) {
    const aes = nodeCrypto.createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([aes.update(buffer), aes.final()]);
}

function aesEncrypt(buffer, key) {
    const iv = nodeCrypto.randomBytes(16);
    const aes = nodeCrypto.createCipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([iv, aes.update(buffer), aes.final()]);
}

function aesEncryptWithIV(buffer, key, iv) {
    const aes = nodeCrypto.createCipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([aes.update(buffer), aes.final()]);
}

function hmacSign(buffer, key, variant) {
    variant = variant || 'sha256';
    return nodeCrypto.createHmac(variant, key).update(buffer).digest();
}

function sha256(data) {
    return nodeCrypto.createHash('sha256').update(data).digest();
}

function md5(data) {
    return nodeCrypto.createHash('md5').update(data).digest();
}

async function hkdf(buffer, expandedLength, info) {
    const inputKeyMaterial = new Uint8Array(
        buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
    );
    const salt = info.salt
        ? new Uint8Array(info.salt)
        : new Uint8Array(0);
    const infoBytes = info.info
        ? new TextEncoder().encode(info.info)
        : new Uint8Array(0);

    const importedKey = await nodeCrypto.subtle.importKey(
        'raw', inputKeyMaterial, { name: 'HKDF' }, false, ['deriveBits']
    );
    const derivedBits = await nodeCrypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt, info: infoBytes },
        importedKey,
        expandedLength * 8
    );
    return Buffer.from(derivedBits);
}

async function derivePairingCodeKey(pairingCode, salt) {
    const encoder = new TextEncoder();
    const pairingCodeBuffer = encoder.encode(pairingCode);
    const saltBuffer = new Uint8Array(
        salt instanceof Uint8Array ? salt : new Uint8Array(salt)
    );
    const keyMaterial = await nodeCrypto.subtle.importKey(
        'raw', pairingCodeBuffer, { name: 'PBKDF2' }, false, ['deriveBits']
    );
    const derivedBits = await nodeCrypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: saltBuffer, iterations: 2 << 16, hash: 'SHA-256' },
        keyMaterial,
        32 * 8
    );
    return Buffer.from(derivedBits);
}

function encodeBigEndian(e, t) {
    t = t || 4;
    let r = e;
    const a = new Uint8Array(t);
    for (let i = t - 1; i >= 0; i--) {
        a[i] = 255 & r;
        r >>>= 8;
    }
    return Buffer.from(a);
}

function generateRegistrationId() {
    return Uint16Array.from(nodeCrypto.randomBytes(2))[0] & 16383;
}

function writeRandomPadMax16(msg) {
    const pad = nodeCrypto.randomBytes(1);
    const padLength = (pad[0] & 0x0f) + 1;
    return Buffer.concat([msg, Buffer.alloc(padLength, padLength)]);
}

function unpadRandomMax16(e) {
    const t = new Uint8Array(e);
    if (t.length === 0) {
        throw new Error('unpadPkcs7 given empty bytes');
    }
    const r = t[t.length - 1];
    if (r > t.length) {
        throw new Error(`unpad given ${t.length} bytes, but pad is ${r}`);
    }
    return new Uint8Array(t.buffer, t.byteOffset, t.length - r);
}

module.exports = {
    KEY_BUNDLE_TYPE,
    generateSignalPubKey,
    Curve,
    signedKeyPair,
    aesEncryptGCM,
    aesDecryptGCM,
    aesEncryptCTR,
    aesDecryptCTR,
    aesDecrypt,
    aesDecryptWithIV,
    aesEncrypt,
    aesEncryptWithIV,
    hmacSign,
    sha256,
    md5,
    hkdf,
    derivePairingCodeKey,
    encodeBigEndian,
    generateRegistrationId,
    writeRandomPadMax16,
    unpadRandomMax16
};
