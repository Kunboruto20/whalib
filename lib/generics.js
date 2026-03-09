'use strict';

const nodeCrypto = require('crypto');
const { getAllBinaryNodeChildren } = require('./binary-node');
const { jidDecode } = require('./jid-utils');
const { sha256, writeRandomPadMax16 } = require('./crypto-utils');

const DISCONNECT_REASON = {
    connectionClosed: 428,
    connectionLost: 408,
    connectionReplaced: 440,
    timedOut: 408,
    loggedOut: 401,
    badSession: 500,
    restartRequired: 515,
    multideviceMismatch: 411
};

const BufferJSON = {
    replacer(k, value) {
        if (Buffer.isBuffer(value) || value instanceof Uint8Array || value?.type === 'Buffer') {
            return { type: 'Buffer', data: Buffer.from(value?.data || value).toString('base64') };
        }
        return value;
    },
    reviver(_, value) {
        if (typeof value === 'object' && value !== null && value.type === 'Buffer' && typeof value.data === 'string') {
            return Buffer.from(value.data, 'base64');
        }
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            const keys = Object.keys(value);
            if (keys.length > 0 && keys.every(k => !isNaN(parseInt(k, 10)))) {
                const values = Object.values(value);
                if (values.every(v => typeof v === 'number')) {
                    return Buffer.from(values);
                }
            }
        }
        return value;
    }
};

const delay = (ms) => delayCancellable(ms).delay;

const delayCancellable = (ms) => {
    const stack = new Error().stack;
    let timeout;
    let reject;
    const promise = new Promise((resolve, _reject) => {
        timeout = setTimeout(resolve, ms);
        reject = _reject;
    });
    const cancel = () => {
        clearTimeout(timeout);
        reject(Object.assign(new Error('Cancelled'), { statusCode: 500, data: { stack } }));
    };
    return { delay: promise, cancel };
};

const debouncedTimeout = (intervalMs = 1000, task) => {
    let timeout;
    return {
        start(newIntervalMs, newTask) {
            task = newTask || task;
            intervalMs = newIntervalMs || intervalMs;
            if (timeout) clearTimeout(timeout);
            timeout = setTimeout(() => task?.(), intervalMs);
        },
        cancel() {
            if (timeout) clearTimeout(timeout);
            timeout = undefined;
        },
        setTask(newTask) { task = newTask; },
        setInterval(newInterval) { intervalMs = newInterval; }
    };
};

const makeMutex = () => {
    let task = Promise.resolve();
    let taskTimeout;
    return {
        mutex(code) {
            task = (async () => {
                try { await task; } catch {}
                try {
                    return await code();
                } finally {
                    clearTimeout(taskTimeout);
                }
            })();
            return task;
        }
    };
};

const makeKeyedMutex = () => {
    const map = {};
    return {
        mutex(key, task) {
            if (!map[key]) {
                map[key] = makeMutex();
            }
            return map[key].mutex(task);
        }
    };
};

const unixTimestampSeconds = (date) => Math.floor((date || new Date()).getTime() / 1000);

const toNumber = (t) => typeof t === 'object' && t ? ('toNumber' in t ? t.toNumber() : t.low) : t || 0;

const generateParticipantHashV2 = (participants) => {
    participants.sort();
    const hash = sha256(Buffer.from(participants.join(''))).toString('base64');
    return '2:' + hash.slice(0, 6);
};

const encodeWAMessage = (message, proto) => {
    return writeRandomPadMax16(Buffer.from(proto.Message.encode(message).finish()));
};

const decodedPaddedMessage = (msg) => {
    const t = new Uint8Array(msg);
    if (t.length === 0) {
        throw new Error('unpadPkcs7 given empty bytes');
    }
    const r = t[t.length - 1];
    if (r > t.length) {
        throw new Error(`unpad given ${t.length} bytes, but pad is ${r}`);
    }
    return new Uint8Array(t.buffer, t.byteOffset, t.length - r);
};

async function promiseTimeout(ms, promise) {
    if (!ms) {
        return new Promise(promise);
    }
    const stack = new Error().stack;
    const { delay: delayPromise, cancel } = delayCancellable(ms);
    const p = new Promise((resolve, reject) => {
        delayPromise
            .then(() => reject(Object.assign(new Error('Timed Out'), {
                statusCode: DISCONNECT_REASON.timedOut,
                data: { stack }
            })))
            .catch(err => reject(err));
        promise(resolve, reject);
    }).finally(cancel);
    return p;
}

const generateMessageIDV2 = (userId) => {
    const data = Buffer.alloc(8 + 20 + 16);
    data.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));
    if (userId) {
        const id = jidDecode(userId);
        if (id?.user) {
            data.write(id.user, 8);
            data.write('@c.us', 8 + id.user.length);
        }
    }
    const random = nodeCrypto.randomBytes(16);
    random.copy(data, 28);
    const hash = nodeCrypto.createHash('sha256').update(data).digest();
    return '3EB0' + hash.toString('hex').toUpperCase().substring(0, 18);
};

const generateMessageID = () => '3EB0' + nodeCrypto.randomBytes(18).toString('hex').toUpperCase();

function bindWaitForEvent(ev, event) {
    return async (check, timeoutMs) => {
        let listener;
        let closeListener;
        await promiseTimeout(timeoutMs, (resolve, reject) => {
            closeListener = ({ connection, lastDisconnect }) => {
                if (connection === 'close') {
                    reject(lastDisconnect?.error || Object.assign(new Error('Connection Closed'), { statusCode: DISCONNECT_REASON.connectionClosed }));
                }
            };
            ev.on('connection.update', closeListener);
            listener = async (update) => {
                if (await check(update)) {
                    resolve();
                }
            };
            ev.on(event, listener);
        }).finally(() => {
            ev.off(event, listener);
            ev.off('connection.update', closeListener);
        });
    };
}

const bindWaitForConnectionUpdate = (ev) => bindWaitForEvent(ev, 'connection.update');

const fetchLatestWaWebVersion = async (options = {}) => {
    const fallbackVersion = [2, 3000, 1034754302];
    try {
        const defaultHeaders = {
            'sec-fetch-site': 'none',
            'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        };
        const headers = { ...defaultHeaders, ...options.headers };
        const response = await fetch('https://web.whatsapp.com/sw.js', {
            ...options,
            method: 'GET',
            headers
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch sw.js: ${response.statusText}`);
        }
        const data = await response.text();
        const regex = /\\?"client_revision\\?":\s*(\d+)/;
        const match = data.match(regex);
        if (!match?.[1]) {
            return { version: fallbackVersion, isLatest: false, error: { message: 'Could not find client revision' } };
        }
        return { version: [2, 3000, +match[1]], isLatest: true };
    } catch (error) {
        return { version: fallbackVersion, isLatest: false, error };
    }
};

const generateMdTagPrefix = () => {
    const bytes = nodeCrypto.randomBytes(4);
    return `${bytes.readUInt16BE()}.${bytes.readUInt16BE(2)}-`;
};

const getStatusFromReceiptType = (type) => {
    const STATUS_MAP = {
        sender: 3,
        played: 5,
        read: 4,
        'read-self': 4
    };
    if (typeof type === 'undefined') {
        return 3;
    }
    return STATUS_MAP[type];
};

const getErrorCodeFromStreamError = (node) => {
    const [reasonNode] = getAllBinaryNodeChildren(node);
    let reason = reasonNode?.tag || 'unknown';
    const CODE_MAP = { conflict: DISCONNECT_REASON.connectionReplaced };
    const statusCode = +(node.attrs.code || CODE_MAP[reason] || DISCONNECT_REASON.badSession);
    if (statusCode === DISCONNECT_REASON.restartRequired) {
        reason = 'restart required';
    }
    return { reason, statusCode };
};

const getCallStatusFromNode = ({ tag, attrs }) => {
    let status;
    switch (tag) {
        case 'offer':
        case 'offer_notice':
            status = 'offer';
            break;
        case 'terminate':
            status = attrs.reason === 'timeout' ? 'timeout' : 'terminate';
            break;
        case 'reject':
            status = 'reject';
            break;
        case 'accept':
            status = 'accept';
            break;
        default:
            status = 'ringing';
            break;
    }
    return status;
};

const UNEXPECTED_SERVER_CODE_TEXT = 'Unexpected server response: ';

const getCodeFromWSError = (error) => {
    let statusCode = 500;
    if (error?.message?.includes(UNEXPECTED_SERVER_CODE_TEXT)) {
        const code = +error.message.slice(UNEXPECTED_SERVER_CODE_TEXT.length);
        if (!Number.isNaN(code) && code >= 400) {
            statusCode = code;
        }
    } else if (error?.code?.startsWith?.('E') || error?.message?.includes('timed out')) {
        statusCode = 408;
    }
    return statusCode;
};

const isWABusinessPlatform = (platform) => platform === 'smbi' || platform === 'smba';

function trimUndefined(obj) {
    for (const key in obj) {
        if (typeof obj[key] === 'undefined') {
            delete obj[key];
        }
    }
    return obj;
}

const CROCKFORD_CHARACTERS = '123456789ABCDEFGHJKLMNPQRSTVWXYZ';

function bytesToCrockford(buffer) {
    let value = 0;
    let bitCount = 0;
    const crockford = [];
    for (const element of buffer) {
        value = (value << 8) | (element & 0xff);
        bitCount += 8;
        while (bitCount >= 5) {
            crockford.push(CROCKFORD_CHARACTERS.charAt((value >>> (bitCount - 5)) & 31));
            bitCount -= 5;
        }
    }
    if (bitCount > 0) {
        crockford.push(CROCKFORD_CHARACTERS.charAt((value << (5 - bitCount)) & 31));
    }
    return crockford.join('');
}

function encodeNewsletterMessage(message, proto) {
    return Buffer.from(proto.Message.encode(message).finish());
}

const getKeyAuthor = (key, meId = 'me') => (key?.fromMe ? meId : key?.participantAlt || key?.remoteJidAlt || key?.participant || key?.remoteJid) || '';

const encodeBigEndian = (e, t = 4) => {
    let r = e;
    const a = new Uint8Array(t);
    for (let i = t - 1; i >= 0; i--) {
        a[i] = 255 & r;
        r >>>= 8;
    }
    return Buffer.from(a);
};

module.exports = {
    BufferJSON,
    delay,
    delayCancellable,
    debouncedTimeout,
    makeMutex,
    makeKeyedMutex,
    unixTimestampSeconds,
    toNumber,
    generateParticipantHashV2,
    encodeWAMessage,
    decodedPaddedMessage,
    promiseTimeout,
    generateMessageIDV2,
    generateMessageID,
    bindWaitForEvent,
    bindWaitForConnectionUpdate,
    fetchLatestWaWebVersion,
    generateMdTagPrefix,
    getStatusFromReceiptType,
    getErrorCodeFromStreamError,
    getCallStatusFromNode,
    getCodeFromWSError,
    isWABusinessPlatform,
    trimUndefined,
    bytesToCrockford,
    encodeNewsletterMessage,
    getKeyAuthor,
    encodeBigEndian,
    DISCONNECT_REASON
};
