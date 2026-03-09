'use strict';

const { mkdir, readFile, stat, unlink, writeFile, rename } = require('fs/promises');
const { join } = require('path');
const nodeCrypto = require('crypto');
const { Curve, signedKeyPair, generateRegistrationId } = require('./crypto-utils');

const BufferJSON = {
    replacer(key, value) {
        if (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
            return { type: 'Buffer', data: Buffer.from(value.data).toString('base64') };
        }
        if (Buffer.isBuffer(value)) {
            return { type: 'Buffer', data: value.toString('base64') };
        }
        return value;
    },
    reviver(key, value) {
        if (value && typeof value === 'object' && value.type === 'Buffer' && typeof value.data === 'string') {
            return Buffer.from(value.data, 'base64');
        }
        return value;
    }
};

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1000;

function initAuthCreds() {
    const identityKey = Curve.generateKeyPair();
    const signedIdentityKey = {
        public: identityKey.public,
        private: identityKey.private
    };
    const registrationId = generateRegistrationId();
    const advSecretKey = nodeCrypto.randomBytes(32).toString('base64');
    const noiseKey = Curve.generateKeyPair();
    const pairingEphemeralKeyPair = Curve.generateKeyPair();
    const signedPreKeyData = signedKeyPair(signedIdentityKey, 1);

    return {
        noiseKey,
        pairingEphemeralKeyPair,
        signedIdentityKey,
        signedPreKey: signedPreKeyData,
        registrationId,
        advSecretKey,
        processedHistoryMessages: [],
        nextPreKeyId: 1,
        firstUnuploadedPreKeyId: 1,
        accountSyncCounter: 0,
        accountSettings: {
            unarchiveChats: false
        },
        registered: false,
        account: null,
        me: null,
        signalIdentities: [],
        platform: undefined,
        routingInfo: undefined,
        pairingCode: undefined,
        lastPropHash: undefined
    };
}

function makeLRUCache(ttlMs, maxSize) {
    const store = new Map();
    const timestamps = new Map();

    function evictExpired() {
        const now = Date.now();
        for (const [k, ts] of timestamps) {
            if (now - ts > ttlMs) {
                store.delete(k);
                timestamps.delete(k);
            }
        }
    }

    function enforceMaxSize() {
        if (store.size <= maxSize) return;
        const iter = store.keys();
        while (store.size > maxSize) {
            const oldest = iter.next().value;
            store.delete(oldest);
            timestamps.delete(oldest);
        }
    }

    return {
        get(key) {
            const ts = timestamps.get(key);
            if (ts && Date.now() - ts > ttlMs) {
                store.delete(key);
                timestamps.delete(key);
                return undefined;
            }
            return store.get(key);
        },
        set(key, value) {
            store.delete(key);
            store.set(key, value);
            timestamps.set(key, Date.now());
            enforceMaxSize();
        },
        clear() {
            store.clear();
            timestamps.clear();
        },
        get size() {
            evictExpired();
            return store.size;
        }
    };
}

function makeCacheableSignalKeyStore(store, logger) {
    const cache = makeLRUCache(DEFAULT_CACHE_TTL_MS, MAX_CACHE_ENTRIES);
    let pendingLock = null;

    function cacheKey(type, id) {
        return `${type}.${id}`;
    }

    async function withLock(fn) {
        while (pendingLock) {
            await pendingLock;
        }
        let resolve;
        pendingLock = new Promise(r => { resolve = r; });
        try {
            return await fn();
        } finally {
            pendingLock = null;
            resolve();
        }
    }

    return {
        async get(type, ids) {
            return withLock(async () => {
                const result = {};
                const uncached = [];
                for (const id of ids) {
                    const cached = cache.get(cacheKey(type, id));
                    if (cached !== undefined) {
                        result[id] = cached;
                    } else {
                        uncached.push(id);
                    }
                }
                if (uncached.length > 0) {
                    if (logger) {
                        logger.trace({ count: uncached.length }, 'fetching keys from backing store');
                    }
                    const fromStore = await store.get(type, uncached);
                    for (const id of uncached) {
                        const val = fromStore[id];
                        if (val) {
                            result[id] = val;
                            cache.set(cacheKey(type, id), val);
                        }
                    }
                }
                return result;
            });
        },
        async set(data) {
            return withLock(async () => {
                let count = 0;
                for (const type in data) {
                    for (const id in data[type]) {
                        cache.set(cacheKey(type, id), data[type][id]);
                        count++;
                    }
                }
                if (logger) {
                    logger.trace({ keys: count }, 'cache updated');
                }
                await store.set(data);
            });
        },
        async clear() {
            cache.clear();
            if (store.clear) {
                await store.clear();
            }
        }
    };
}

function sleepMs(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function addTransactionCapability(keyStore, logger, opts) {
    const maxRetries = (opts && opts.maxCommitRetries) || 3;
    const retryDelayMs = (opts && opts.delayBetweenTriesMs) || 500;
    let activeTx = null;

    async function commitMutations(mutations) {
        const keys = Object.keys(mutations);
        if (keys.length === 0) {
            if (logger) logger.trace('transaction had no mutations to commit');
            return;
        }
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                await keyStore.set(mutations);
                if (logger) logger.trace({ types: keys.length }, 'transaction committed');
                return;
            } catch (err) {
                const remaining = maxRetries - attempt - 1;
                if (logger) logger.warn(`commit failed, ${remaining} retries left`);
                if (remaining === 0) throw err;
                await sleepMs(retryDelayMs);
            }
        }
    }

    return {
        async get(type, ids) {
            if (!activeTx) {
                return keyStore.get(type, ids);
            }
            const txCache = activeTx.cache;
            const txCacheForType = txCache[type] || {};
            const needed = ids.filter(id => !(id in txCacheForType));
            if (needed.length > 0) {
                activeTx.queries++;
                if (logger) logger.trace({ type, needed: needed.length }, 'tx: fetching missing');
                const fetched = await keyStore.get(type, needed);
                txCache[type] = txCache[type] || {};
                Object.assign(txCache[type], fetched);
            }
            const out = {};
            for (const id of ids) {
                const v = (txCache[type] || {})[id];
                if (v !== undefined && v !== null) {
                    out[id] = v;
                }
            }
            return out;
        },
        async set(data) {
            if (!activeTx) {
                await keyStore.set(data);
                return;
            }
            if (logger) logger.trace({ types: Object.keys(data) }, 'tx: buffering mutations');
            for (const type in data) {
                activeTx.cache[type] = activeTx.cache[type] || {};
                activeTx.mutations[type] = activeTx.mutations[type] || {};
                Object.assign(activeTx.cache[type], data[type]);
                Object.assign(activeTx.mutations[type], data[type]);
            }
        },
        isInTransaction() {
            return !!activeTx;
        },
        async transaction(work, _key) {
            if (activeTx) {
                if (logger) logger.trace('nested transaction, reusing context');
                return work();
            }
            activeTx = { cache: {}, mutations: {}, queries: 0 };
            try {
                if (logger) logger.trace('starting transaction');
                const result = await work();
                await commitMutations(activeTx.mutations);
                if (logger) logger.trace({ queries: activeTx.queries }, 'transaction complete');
                return result;
            } catch (err) {
                if (logger) logger.error({ err }, 'transaction rolled back');
                throw err;
            } finally {
                activeTx = null;
            }
        }
    };
}

async function useMultiFileAuthState(folder) {
    const fixFileName = (file) => file?.replace(/\//g, '__')?.replace(/:/g, '-');

    const atomicWrite = async (filePath, content) => {
        const tmpPath = filePath + '.tmp.' + Date.now();
        try {
            await writeFile(tmpPath, content);
            await rename(tmpPath, filePath);
        } catch (err) {
            try { await unlink(tmpPath); } catch {}
            throw err;
        }
    };

    const writeData = async (data, file) => {
        const filePath = join(folder, fixFileName(file));
        const serialized = JSON.stringify(data, BufferJSON.replacer);
        await atomicWrite(filePath, serialized);
    };

    const readData = async (file) => {
        try {
            const filePath = join(folder, fixFileName(file));
            const raw = await readFile(filePath, { encoding: 'utf-8' });
            return JSON.parse(raw, BufferJSON.reviver);
        } catch (err) {
            if (err.code === 'ENOENT') return null;
            throw err;
        }
    };

    const removeData = async (file) => {
        try {
            const filePath = join(folder, fixFileName(file));
            await unlink(filePath);
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
    };

    const folderInfo = await stat(folder).catch(() => null);
    if (folderInfo) {
        if (!folderInfo.isDirectory()) {
            throw new Error(`Expected directory at ${folder}, found a file`);
        }
    } else {
        await mkdir(folder, { recursive: true });
    }

    const creds = (await readData('creds.json')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}.json`);
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const file = `${category}-${id}.json`;
                            tasks.push(value ? writeData(value, file) : removeData(file));
                        }
                    }
                    await Promise.all(tasks);
                },
                transaction: async (fn, id) => {
                    return fn();
                }
            }
        },
        saveCreds: async () => {
            return writeData(creds, 'creds.json');
        }
    };
}

module.exports = {
    initAuthCreds,
    useMultiFileAuthState,
    BufferJSON,
    makeCacheableSignalKeyStore,
    addTransactionCapability
};
