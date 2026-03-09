'use strict';

const crypto = require('crypto');

const SEED_MESSAGE_KEY = Buffer.from([0x01]);
const SEED_CHAIN_KEY = Buffer.from([0x02]);
const MAX_FORWARD_JUMPS = 2000;
const MAX_MESSAGE_KEYS = 2000;

class SenderKeyState {
    constructor(id, iteration, chainKey, signatureKeyPublic, signatureKeyPrivate) {
        this.id = id;
        this.iteration = iteration || 0;
        this.chainKey = chainKey ? Buffer.from(chainKey) : null;
        this.signatureKeyPublic = signatureKeyPublic ? Buffer.from(signatureKeyPublic) : null;
        this.signatureKeyPrivate = signatureKeyPrivate ? Buffer.from(signatureKeyPrivate) : null;
        this.messageKeys = new Map();
    }

    getSeedChainKey() {
        return this.chainKey;
    }

    getIteration() {
        return this.iteration;
    }

    getSenderKeyId() {
        return this.id;
    }

    getSigningKeyPublic() {
        return this.signatureKeyPublic;
    }

    getSigningKeyPrivate() {
        return this.signatureKeyPrivate;
    }

    hasSenderKeyId(id) {
        return this.id === id;
    }

    static deriveKeys(chainKey) {
        const messageKey = crypto.createHmac('sha256', chainKey).update(SEED_MESSAGE_KEY).digest();
        const nextChainKey = crypto.createHmac('sha256', chainKey).update(SEED_CHAIN_KEY).digest();
        return { messageKey, nextChainKey };
    }

    advanceChainKey() {
        const { messageKey, nextChainKey } = SenderKeyState.deriveKeys(this.chainKey);
        const currentIteration = this.iteration;
        this.chainKey = nextChainKey;
        this.iteration = currentIteration + 1;
        return { messageKey, iteration: currentIteration };
    }

    getMessageKeyForIteration(targetIteration) {
        if (this.messageKeys.has(targetIteration)) {
            const mk = this.messageKeys.get(targetIteration);
            this.messageKeys.delete(targetIteration);
            return mk;
        }

        if (targetIteration < this.iteration) {
            throw new Error(
                `Message key for iteration ${targetIteration} already consumed (current: ${this.iteration})`
            );
        }

        if (targetIteration - this.iteration > MAX_FORWARD_JUMPS) {
            throw new Error(
                `Too many skipped sender key iterations: ${targetIteration - this.iteration}`
            );
        }

        while (this.iteration < targetIteration) {
            const { messageKey } = this.advanceChainKey();
            this.messageKeys.set(this.iteration - 1, messageKey);
            if (this.messageKeys.size > MAX_MESSAGE_KEYS) {
                const oldest = this.messageKeys.keys().next().value;
                this.messageKeys.delete(oldest);
            }
        }

        const { messageKey } = this.advanceChainKey();
        return messageKey;
    }

    serialize() {
        const mkObj = {};
        for (const [k, v] of this.messageKeys) {
            mkObj[k] = v.toString('base64');
        }
        return {
            id: this.id,
            iteration: this.iteration,
            chainKey: this.chainKey ? this.chainKey.toString('base64') : null,
            signatureKeyPublic: this.signatureKeyPublic ? this.signatureKeyPublic.toString('base64') : null,
            signatureKeyPrivate: this.signatureKeyPrivate ? this.signatureKeyPrivate.toString('base64') : null,
            messageKeys: mkObj
        };
    }

    static deserialize(data) {
        const state = new SenderKeyState(
            data.id,
            data.iteration,
            data.chainKey ? Buffer.from(data.chainKey, 'base64') : null,
            data.signatureKeyPublic ? Buffer.from(data.signatureKeyPublic, 'base64') : null,
            data.signatureKeyPrivate ? Buffer.from(data.signatureKeyPrivate, 'base64') : null
        );
        if (data.messageKeys) {
            for (const [k, v] of Object.entries(data.messageKeys)) {
                state.messageKeys.set(Number(k), Buffer.from(v, 'base64'));
            }
        }
        return state;
    }
}

class SenderKeyRecord {
    constructor() {
        this.states = [];
    }

    isEmpty() {
        return this.states.length === 0;
    }

    getState(keyId) {
        if (keyId !== undefined && keyId !== null) {
            for (const state of this.states) {
                if (state.hasSenderKeyId(keyId)) {
                    return state;
                }
            }
            throw new Error(`No sender key state for id: ${keyId}`);
        }
        if (this.states.length === 0) {
            throw new Error('No sender key state');
        }
        return this.states[0];
    }

    addState(id, iteration, chainKey, signatureKeyPublic, signatureKeyPrivate) {
        const state = new SenderKeyState(id, iteration, chainKey, signatureKeyPublic, signatureKeyPrivate);
        this.states.unshift(state);
        if (this.states.length > 5) {
            this.states.length = 5;
        }
    }

    setSenderKeyState(id, iteration, chainKey, signatureKeyPublic, signatureKeyPrivate) {
        this.states = [];
        this.addState(id, iteration, chainKey, signatureKeyPublic, signatureKeyPrivate);
    }

    serialize() {
        return JSON.stringify({
            states: this.states.map(s => s.serialize())
        });
    }

    static deserialize(data) {
        const record = new SenderKeyRecord();
        let parsed;
        if (typeof data === 'string') {
            parsed = JSON.parse(data);
        } else if (Buffer.isBuffer(data)) {
            parsed = JSON.parse(data.toString());
        } else {
            parsed = data;
        }
        if (parsed.states) {
            record.states = parsed.states.map(s => SenderKeyState.deserialize(s));
        }
        return record;
    }
}

module.exports = { SenderKeyRecord, SenderKeyState };
