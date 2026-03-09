'use strict';

const { hkdf } = require('./crypto-utils');

const LT_HASH_SIZE = 128;

class LTHash {
    constructor(salt) {
        this.salt = salt;
    }

    async add(hash, items) {
        let result = hash;
        for (const item of items) {
            result = await this._addSingle(result, item);
        }
        return result;
    }

    async subtract(hash, items) {
        let result = hash;
        for (const item of items) {
            result = await this._subtractSingle(result, item);
        }
        return result;
    }

    async subtractThenAdd(hash, addItems, subItems) {
        const subtracted = await this.subtract(hash, subItems);
        return this.add(subtracted, addItems);
    }

    async _addSingle(hash, item) {
        const derived = new Uint8Array(
            await hkdf(Buffer.from(item), LT_HASH_SIZE, { info: this.salt })
        ).buffer;
        return this._pointwiseOp(hash, derived, (a, b) => a + b);
    }

    async _subtractSingle(hash, item) {
        const derived = new Uint8Array(
            await hkdf(Buffer.from(item), LT_HASH_SIZE, { info: this.salt })
        ).buffer;
        return this._pointwiseOp(hash, derived, (a, b) => a - b);
    }

    _pointwiseOp(a, b, op) {
        const viewA = new DataView(a instanceof ArrayBuffer ? a : a.buffer || a);
        const viewB = new DataView(b instanceof ArrayBuffer ? b : b.buffer || b);
        const out = new ArrayBuffer(viewA.byteLength);
        const viewOut = new DataView(out);
        for (let i = 0; i < viewA.byteLength; i += 2) {
            viewOut.setUint16(
                i,
                op(viewA.getUint16(i, true), viewB.getUint16(i, true)),
                true
            );
        }
        return out;
    }
}

const LT_HASH_ANTI_TAMPERING = new LTHash('WhatsApp Patch Integrity');

module.exports = {
    LTHash,
    LT_HASH_ANTI_TAMPERING
};
