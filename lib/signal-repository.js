'use strict';

const SessionCipher = require('../signal/session_cipher');
const SessionBuilder = require('../signal/session_builder');
const SessionRecord = require('../signal/session_record');
const ProtocolAddress = require('../signal/protocol_address');
const GroupCipher = require('../signal/group_cipher');
const GroupSessionBuilder = require('../signal/group_session_builder');
const { SenderKeyRecord } = require('../signal/sender_key_record');
const { jidDecode, jidNormalizedUser } = require('./jid-utils');
const { generateSignalPubKey, writeRandomPadMax16, unpadRandomMax16 } = require('./crypto-utils');
const { makeMutex, makeKeyedMutex } = require('./generics');

function jidToSignalAddress(jid) {
    const decoded = jidDecode(jid);
    if (!decoded) throw new Error(`Invalid JID: ${jid}`);
    const user = decoded.user;
    const device = decoded.device || 0;
    return new ProtocolAddress(user, device);
}

function jidToSignalSenderKeyName(group, sender) {
    const groupDecoded = jidDecode(group);
    const senderDecoded = jidDecode(sender);
    if (!groupDecoded || !senderDecoded) {
        return `${group}::${sender}::0`;
    }
    return `${groupDecoded.user}::${senderDecoded.user}::${senderDecoded.device || 0}`;
}

function createSignalStorage(keys, creds) {
    return {
        loadSession: async (id) => {
            const sessions = await keys.get('session', [id]);
            const raw = sessions[id];
            if (raw) {
                if (raw instanceof SessionRecord) return raw;
                return SessionRecord.deserialize(raw);
            }
            return null;
        },
        storeSession: async (id, record) => {
            await keys.set({ session: { [id]: record.serialize() } });
        },
        isTrustedIdentity: async () => {
            return true;
        },
        loadPreKey: async (id) => {
            const preKeys = await keys.get('pre-key', [id]);
            const raw = preKeys[id];
            if (raw) {
                return {
                    privKey: Buffer.isBuffer(raw.private) ? raw.private : Buffer.from(raw.private || raw.keyPair?.private || []),
                    pubKey: generateSignalPubKey(Buffer.isBuffer(raw.public) ? raw.public : Buffer.from(raw.public || raw.keyPair?.public || []))
                };
            }
            return null;
        },
        removePreKey: async (id) => {
            await keys.set({ 'pre-key': { [id]: null } });
        },
        loadSignedPreKey: async (id) => {
            const signedPreKeys = await keys.get('signed-pre-key', [id]);
            const raw = signedPreKeys[id];
            if (raw) {
                return {
                    privKey: Buffer.isBuffer(raw.private) ? raw.private : Buffer.from(raw.private || raw.keyPair?.private || []),
                    pubKey: generateSignalPubKey(Buffer.isBuffer(raw.public) ? raw.public : Buffer.from(raw.public || raw.keyPair?.public || []))
                };
            }
            const spk = creds.signedPreKey;
            if (spk && spk.keyId === id) {
                return {
                    privKey: Buffer.from(spk.keyPair.private),
                    pubKey: generateSignalPubKey(Buffer.from(spk.keyPair.public))
                };
            }
            return null;
        },
        getOurRegistrationId: async () => {
            return creds.registrationId;
        },
        getOurIdentity: async () => {
            return {
                pubKey: generateSignalPubKey(Buffer.from(creds.signedIdentityKey.public)),
                privKey: Buffer.from(creds.signedIdentityKey.private)
            };
        }
    };
}

function createSenderKeyStore(keys) {
    return {
        loadSenderKey: async (senderKeyName) => {
            const senderKeys = await keys.get('sender-key', [senderKeyName]);
            const raw = senderKeys[senderKeyName];
            if (raw) {
                if (raw instanceof SenderKeyRecord) return raw;
                return SenderKeyRecord.deserialize(raw);
            }
            return null;
        },
        storeSenderKey: async (senderKeyName, record) => {
            await keys.set({ 'sender-key': { [senderKeyName]: record.serialize() } });
        }
    };
}

function createSignalRepository({ creds, keys }) {
    const storage = createSignalStorage(keys, creds);
    const senderKeyStore = createSenderKeyStore(keys);

    const senderKeyDistributionCache = {};

    const sessionMutex = makeKeyedMutex();
    const groupMutex = makeKeyedMutex();

    async function encryptMessage(args) {
        const jid = typeof args === 'string' ? args : args.jid;
        const data = typeof args === 'string' ? arguments[1] : args.data;
        return sessionMutex.mutex(jid, async () => {
            const addr = jidToSignalAddress(jid);
            const cipher = new SessionCipher(storage, addr);
            const padded = writeRandomPadMax16(Buffer.from(data));
            const result = await cipher.encrypt(padded);
            return {
                type: result.type === 3 ? 'pkmsg' : 'msg',
                ciphertext: result.body
            };
        });
    }

    async function decryptMessage(args) {
        const jid = typeof args === 'string' ? args : args.jid;
        const type = typeof args === 'string' ? arguments[1] : args.type;
        const ciphertext = typeof args === 'string' ? arguments[2] : args.ciphertext;
        return sessionMutex.mutex(jid, async () => {
            const addr = jidToSignalAddress(jid);
            const cipher = new SessionCipher(storage, addr);
            let plaintext;
            if (type === 'pkmsg') {
                plaintext = await cipher.decryptPreKeyWhisperMessage(Buffer.from(ciphertext));
            } else {
                plaintext = await cipher.decryptWhisperMessage(Buffer.from(ciphertext));
            }
            return Buffer.from(unpadRandomMax16(plaintext));
        });
    }

    async function encryptGroupMessage(args) {
        const group = typeof args === 'string' ? args : args.group;
        const meId = typeof args === 'string' ? arguments[1] : args.meId;
        const data = typeof args === 'string' ? arguments[2] : args.data;
        const senderKeyName = jidToSignalSenderKeyName(group, meId);

        return groupMutex.mutex(senderKeyName, async () => {
            const builder = new GroupSessionBuilder(senderKeyStore);
            const senderKeyDistributionMessage = await builder.createSession(senderKeyName);

            const cipher = new GroupCipher(senderKeyStore, senderKeyName);
            const padded = writeRandomPadMax16(Buffer.from(data));
            const ciphertext = await cipher.encrypt(padded);
            return { ciphertext, senderKeyDistributionMessage };
        });
    }

    async function decryptGroupMessage(args) {
        const group = typeof args === 'string' ? args : args.group;
        const senderJid = typeof args === 'string' ? arguments[1] : (args.authorJid || args.senderJid);
        const ciphertext = typeof args === 'string' ? arguments[2] : (args.msg || args.ciphertext);
        const senderKeyName = jidToSignalSenderKeyName(group, senderJid);

        return groupMutex.mutex(senderKeyName, async () => {
            const cipher = new GroupCipher(senderKeyStore, senderKeyName);
            const plaintext = await cipher.decrypt(Buffer.from(ciphertext));
            return Buffer.from(unpadRandomMax16(plaintext));
        });
    }

    async function processSenderKeyDistributionMessage({ item, authorJid }) {
        if (!item || !authorJid) return;
        const groupId = item.groupId;
        if (!groupId) return;
        const senderKeyName = jidToSignalSenderKeyName(groupId, authorJid);

        return groupMutex.mutex(senderKeyName, async () => {
            const builder = new GroupSessionBuilder(senderKeyStore);
            const axolotlMsg = item.axolotlSenderKeyDistributionMessage;
            if (axolotlMsg && axolotlMsg.length > 0) {
                await builder.processDistributionMessage(senderKeyName, axolotlMsg);
            } else {
                let record = await senderKeyStore.loadSenderKey(senderKeyName);
                if (!record) {
                    record = new SenderKeyRecord();
                }
                const chainKey = item.chainKey ? Buffer.from(item.chainKey) : require('crypto').randomBytes(32);
                const signingKey = item.signingKey ? Buffer.from(item.signingKey) : null;
                record.addState(
                    item.iteration || 0,
                    0,
                    chainKey,
                    signingKey,
                    null
                );
                await senderKeyStore.storeSenderKey(senderKeyName, record);
            }
        });
    }

    async function getSenderKeyDistributionMessage(groupJid, meJid) {
        const senderKeyName = jidToSignalSenderKeyName(groupJid, meJid);

        return groupMutex.mutex(senderKeyName, async () => {
            if (senderKeyDistributionCache[senderKeyName]) {
                return senderKeyDistributionCache[senderKeyName];
            }

            const builder = new GroupSessionBuilder(senderKeyStore);
            const distMsg = await builder.createSession(senderKeyName);
            senderKeyDistributionCache[senderKeyName] = distMsg;
            return distMsg;
        });
    }

    async function createSignalSession(jid, preKeyBundle) {
        return sessionMutex.mutex(jid, async () => {
            const addr = jidToSignalAddress(jid);
            const builder = new SessionBuilder(storage, addr);
            const device = {
                registrationId: preKeyBundle.registrationId,
                identityKey: generateSignalPubKey(Buffer.from(preKeyBundle.identityKey)),
                signedPreKey: {
                    keyId: preKeyBundle.signedPreKey.keyId,
                    publicKey: generateSignalPubKey(Buffer.from(preKeyBundle.signedPreKey.publicKey)),
                    signature: Buffer.from(preKeyBundle.signedPreKey.signature)
                }
            };
            if (preKeyBundle.preKey) {
                device.preKey = {
                    keyId: preKeyBundle.preKey.keyId,
                    publicKey: generateSignalPubKey(Buffer.from(preKeyBundle.preKey.publicKey))
                };
            }
            await builder.initOutgoing(device);
        });
    }

    async function injectE2ESession({ jid, session }) {
        if (!session || !jid) return;
        return sessionMutex.mutex(jid, async () => {
            try {
                const addr = jidToSignalAddress(jid);
                const builder = new SessionBuilder(storage, addr);
                const device = {
                    registrationId: session.registrationId,
                    identityKey: session.identityKey,
                    signedPreKey: session.signedPreKey ? {
                        keyId: session.signedPreKey.keyId,
                        publicKey: session.signedPreKey.publicKey,
                        signature: session.signedPreKey.signature
                    } : undefined,
                };
                if (session.preKey) {
                    device.preKey = {
                        keyId: session.preKey.keyId,
                        publicKey: session.preKey.publicKey
                    };
                }
                await builder.initOutgoing(device);
            } catch (err) {
            }
        });
    }

    async function migrateSession(fromJid, toJid) {
        try {
            const fromAddr = jidToSignalAddress(fromJid);
            const fromId = `${fromAddr.getName()}:${fromAddr.getDeviceId()}`;
            const sessions = await keys.get('session', [fromId]);
            const session = sessions[fromId];
            if (session) {
                const toAddr = jidToSignalAddress(toJid);
                const toId = `${toAddr.getName()}:${toAddr.getDeviceId()}`;
                await keys.set({ session: { [toId]: session } });
            }
        } catch {}
    }

    const lidMappingStore = {
        _cache: {},
        async storeLIDPNMappings(pairs) {
            for (const { lid, pn } of pairs) {
                this._cache[lid] = pn;
                this._cache[pn] = lid;
            }
            if (pairs.length) {
                const data = {};
                for (const { lid, pn } of pairs) {
                    data[lid] = pn;
                }
                await keys.set({ 'lid-pn': data });
            }
        },
        async getPNForLID(lid) {
            if (this._cache[lid]) return this._cache[lid];
            const result = await keys.get('lid-pn', [lid]);
            return result[lid] || null;
        },
        async getLIDForPN(pn) {
            if (this._cache[pn]) return this._cache[pn];
            for (const [k, v] of Object.entries(this._cache)) {
                if (v === pn) return k;
            }
            return null;
        }
    };

    return {
        encryptMessage,
        decryptMessage,
        encryptGroupMessage,
        decryptGroupMessage,
        processSenderKeyDistributionMessage,
        getSenderKeyDistributionMessage,
        createSignalSession,
        injectE2ESession,
        migrateSession,
        lidMapping: lidMappingStore,
    };
}

module.exports = {
    createSignalRepository,
    createSignalStorage,
    createSenderKeyStore,
    jidToSignalAddress,
    jidToSignalSenderKeyName
};
