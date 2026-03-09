'use strict';

const WebSocket = require('ws');
const nodeCrypto = require('crypto');
const EventEmitter = require('events');
const { URL } = require('url');

const { makeNoiseHandler } = require('./noise-handler');
const { makeEventBuffer } = require('./event-buffer');
const {
    encodeBinaryNode,
    decodeBinaryNode,
    getBinaryNodeChild,
    getBinaryNodeChildren,
    getAllBinaryNodeChildren,
    binaryNodeToString,
    assertNodeErrorFree,
    getBinaryNodeChildBuffer
} = require('./binary-node');
const {
    generateLoginNode,
    generateRegistrationNode,
    configureSuccessfulPairing
} = require('./validate-connection');
const {
    Curve,
    signedKeyPair,
    encodeBigEndian,
    aesEncryptCTR,
    aesDecryptCTR,
    aesEncryptGCM,
    aesDecryptGCM,
    hmacSign,
    hkdf,
    writeRandomPadMax16,
    unpadRandomMax16,
    derivePairingCodeKey,
    generateSignalPubKey
} = require('./crypto-utils');
const {
    NOISE_WA_HEADER,
    WA_WEB_URL,
    WA_WEB_VERSION,
    WA_BROWSER_DESC,
    WA_DEFAULT_ORIGIN,
    S_WHATSAPP_NET,
    KEEP_ALIVE_INTERVAL,
    DEFAULT_QUERY_TIMEOUT,
    CONNECT_TIMEOUT,
    QR_TIMEOUT,
    INITIAL_PREKEY_COUNT,
    MIN_PREKEY_COUNT,
    KEY_BUNDLE_TYPE,
    DEF_TAG_PREFIX,
    DEF_CALLBACK_PREFIX,
    DISCONNECT_REASON
} = require('./constants');
const { jidDecode, jidEncode, jidNormalizedUser, isJidGroup, isLidUser } = require('./jid-utils');
const { USyncQuery, USyncUser } = require('./usync');
const { createSignalRepository } = require('./signal-repository');
const { makeMessagesSocket } = require('./messages-send');
const { decodeMessageNode, decryptMessageNode, processMessage, cleanMessage } = require('./messages-recv');
const { makeGroupsSocket } = require('./groups');
const { makeNewsletterSocket } = require('./newsletter');
const { makeCommunitiesSocket } = require('./communities');
const { makeBusinessSocket } = require('./business');
const { makeChatsSocket } = require('./chats');
const { downloadContentFromMessage, downloadMediaMessage, encryptedStream } = require('./messages-media');
const { makeMutex, makeKeyedMutex, fetchLatestWaWebVersion, bindWaitForConnectionUpdate } = require('./generics');
const {
    generateWAMessage,
    generateWAMessageContent,
    generateWAMessageFromContent,
    getContentType,
    extractMessageContent,
    normalizeMessageContent,
    loadProto: loadProtoMessages
} = require('./messages');

function generateMdTagPrefix() {
    const bytes = nodeCrypto.randomBytes(4);
    return bytes.readUInt16BE(0) + '.' + bytes.readUInt16BE(2) + '-';
}

function bytesToCrockford(buf) {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTVWXYZ';
    let bits = 0;
    let value = 0;
    let result = '';
    for (let i = 0; i < buf.length; i++) {
        value = (value << 8) | buf[i];
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            result += alphabet[(value >>> bits) & 31];
        }
    }
    if (bits > 0) {
        result += alphabet[(value << (5 - bits)) & 31];
    }
    return result;
}

function makeSocket(config) {
    const {
        waWebSocketUrl = WA_WEB_URL,
        connectTimeoutMs = CONNECT_TIMEOUT,
        keepAliveIntervalMs = KEEP_ALIVE_INTERVAL,
        defaultQueryTimeoutMs = DEFAULT_QUERY_TIMEOUT,
        qrTimeout = QR_TIMEOUT,
        browser = WA_BROWSER_DESC,
        version: userVersion,
        auth: authState,
        logger = console,
        syncFullHistory = false,
        countryCode = 'US'
    } = config;

    let version = userVersion || WA_WEB_VERSION;

    const socketConfig = {
        version,
        browser,
        syncFullHistory,
        countryCode,
        ...config
    };

    const uqTagId = generateMdTagPrefix();
    let epoch = 1;
    const generateMessageTag = () => uqTagId + epoch++;

    const url = new URL(typeof waWebSocketUrl === 'string' ? waWebSocketUrl : WA_WEB_URL);

    if (authState?.creds?.routingInfo) {
        url.searchParams.append('ED', authState.creds.routingInfo.toString('base64url'));
    }

    const ephemeralKeyPair = Curve.generateKeyPair();

    const noise = makeNoiseHandler({
        keyPair: ephemeralKeyPair,
        NOISE_HEADER: NOISE_WA_HEADER,
        logger,
        routingInfo: authState?.creds?.routingInfo
    });

    const wsEmitter = new EventEmitter();
    wsEmitter.setMaxListeners(200);

    const sendMutex = makeMutex();

    let ws = null;
    let wsOpen = false;
    let wsClosed = false;

    function connectWebSocket() {
        ws = new WebSocket(url.toString(), {
            origin: WA_DEFAULT_ORIGIN || 'https://web.whatsapp.com',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits'
            },
            handshakeTimeout: connectTimeoutMs
        });

        ws.on('open', () => {
            wsOpen = true;
            wsEmitter.emit('open');
        });

        ws.on('message', (data) => {
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            wsEmitter.emit('message', buf);
        });

        ws.on('close', (code, reason) => {
            wsOpen = false;
            wsClosed = true;
            wsEmitter.emit('close', code, reason);
        });

        ws.on('error', (err) => {
            wsEmitter.emit('error', err);
        });
    }

    connectWebSocket();

    function sendRaw(data) {
        return new Promise((resolve, reject) => {
            if (!wsOpen || !ws) {
                return reject(new Error('WebSocket not connected'));
            }
            ws.send(data, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    async function sendRawMessage(data) {
        return sendMutex.mutex(async () => {
            if (!wsOpen) {
                const err = new Error('Connection not open');
                err.statusCode = DISCONNECT_REASON.connectionClosed;
                throw err;
            }
            const bytes = noise.encodeFrame(data);
            await promiseTimeout(connectTimeoutMs, async (resolve, reject) => {
                try {
                    await sendRaw(bytes);
                    resolve();
                } catch (err) {
                    reject(err);
                }
            });
        });
    }

    async function sendNode(frame) {
        if (logger.level === 'trace' || logger.trace) {
            const logFn = logger.trace?.bind?.(logger) || logger.log?.bind?.(logger);
            if (logFn) logFn({ xml: binaryNodeToString(frame), msg: 'xml send' });
        }
        const buff = encodeBinaryNode(frame);
        return sendRawMessage(buff);
    }

    function promiseTimeout(ms, executor) {
        let timer;
        const promise = new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Timed out')), ms);
            const wrappedResolve = (val) => { clearTimeout(timer); resolve(val); };
            const wrappedReject = (err) => { clearTimeout(timer); reject(err); };
            executor(wrappedResolve, wrappedReject);
        });
        return promise;
    }

    async function waitForMessage(msgId, timeoutMs) {
        timeoutMs = timeoutMs || defaultQueryTimeoutMs;
        return promiseTimeout(timeoutMs, (resolve, reject) => {
            const onRecv = (data) => {
                wsEmitter.off('TAG:' + msgId, onRecv);
                wsEmitter.off('close', onErr);
                resolve(data);
            };
            const onErr = (err) => {
                wsEmitter.off('TAG:' + msgId, onRecv);
                wsEmitter.off('close', onErr);
                reject(err || new Error('Connection closed'));
            };
            wsEmitter.on('TAG:' + msgId, onRecv);
            wsEmitter.on('close', onErr);
        });
    }

    async function query(node, timeoutMs) {
        if (!node.attrs.id) {
            node.attrs.id = generateMessageTag();
        }
        const msgId = node.attrs.id;
        const result = await promiseTimeout(timeoutMs || defaultQueryTimeoutMs, async (resolve, reject) => {
            const resultPromise = waitForMessage(msgId, timeoutMs).catch(reject);
            sendNode(node)
                .then(async () => resolve(await resultPromise))
                .catch(reject);
        });
        if (result && typeof result === 'object' && 'tag' in result) {
            assertNodeErrorFree(result);
        }
        return result;
    }

    const ev = makeEventBuffer(logger);
    const { creds } = authState;

    const signalRepo = createSignalRepository({ creds, keys: authState.keys });

    const messageStore = new Map();

    let lastDateRecv = null;
    let keepAliveReq = null;
    let qrTimer = null;
    let closed = false;

    async function awaitNextMessage(sendMsg) {
        if (!wsOpen) {
            throw new Error('Connection not open');
        }
        const result = promiseTimeout(connectTimeoutMs, (resolve, reject) => {
            const onFrame = (data) => {
                wsEmitter.off('frame', onFrame);
                wsEmitter.off('close', onClose);
                wsEmitter.off('error', onClose);
                resolve(data);
            };
            const onClose = (err) => {
                wsEmitter.off('frame', onFrame);
                wsEmitter.off('close', onClose);
                wsEmitter.off('error', onClose);
                reject(err || new Error('Connection closed'));
            };
            wsEmitter.on('frame', onFrame);
            wsEmitter.on('close', onClose);
            wsEmitter.on('error', onClose);
        });
        if (sendMsg) {
            sendRaw(sendMsg).catch(() => {});
        }
        return result;
    }

    async function validateConnection() {
        const proto = loadProto();

        let helloMsg = {
            clientHello: { ephemeral: ephemeralKeyPair.public }
        };
        helloMsg = proto.HandshakeMessage.fromObject(helloMsg);
        const init = proto.HandshakeMessage.encode(helloMsg).finish();

        const helloFrame = noise.encodeFrame(init);
        const result = await awaitNextMessage(helloFrame);
        const handshake = proto.HandshakeMessage.decode(result);

        const keyEnc = await noise.processHandshake(handshake, creds.noiseKey);

        let node;
        if (!creds.me) {
            node = generateRegistrationNode(creds, socketConfig);
            logger.info?.('Not logged in, attempting registration...');
        } else {
            node = generateLoginNode(creds.me.id, socketConfig);
            logger.info?.('Logging in...');
        }

        const payloadEnc = noise.encrypt(
            proto.ClientPayload.encode(node).finish()
        );

        const finishFrame = proto.HandshakeMessage.encode({
            clientFinish: {
                static: keyEnc,
                payload: payloadEnc
            }
        }).finish();

        await sendRaw(noise.encodeFrame(finishFrame));

        await noise.finishInit();
        startKeepAliveRequest();
    }

    function startKeepAliveRequest() {
        keepAliveReq = setInterval(() => {
            if (!lastDateRecv) {
                lastDateRecv = new Date();
            }
            const diff = Date.now() - lastDateRecv.getTime();
            if (diff > keepAliveIntervalMs + 5000) {
                end(new Error('Connection lost'));
            } else if (wsOpen) {
                query({
                    tag: 'iq',
                    attrs: {
                        id: generateMessageTag(),
                        to: S_WHATSAPP_NET,
                        type: 'get',
                        xmlns: 'w:p'
                    },
                    content: [{ tag: 'ping', attrs: {} }]
                }).catch(() => {});
            }
        }, keepAliveIntervalMs);
    }

    const sendPassiveIq = (tag) => query({
        tag: 'iq',
        attrs: {
            to: S_WHATSAPP_NET,
            xmlns: 'passive',
            type: 'set'
        },
        content: [{ tag, attrs: {} }]
    });

    async function onMessageReceived(data) {
        await noise.decodeFrame(data, (frame) => {
            lastDateRecv = new Date();
            let anyTriggered = false;
            anyTriggered = wsEmitter.emit('frame', frame);

            if (!(frame instanceof Uint8Array) && frame && typeof frame === 'object' && frame.tag) {
                const msgId = frame.attrs?.id;

                logger.debug?.({ tag: frame.tag, attrs: frame.attrs, childTag: Array.isArray(frame.content) ? frame.content[0]?.tag : undefined }, 'recv frame');

                anyTriggered = wsEmitter.emit(DEF_TAG_PREFIX + msgId, frame) || anyTriggered;

                const l0 = frame.tag;
                const l1 = frame.attrs || {};
                const l2 = Array.isArray(frame.content) ? frame.content[0]?.tag : '';

                for (const key of Object.keys(l1)) {
                    anyTriggered = wsEmitter.emit(DEF_CALLBACK_PREFIX + l0 + ',' + key + ':' + l1[key] + ',' + l2, frame) || anyTriggered;
                    anyTriggered = wsEmitter.emit(DEF_CALLBACK_PREFIX + l0 + ',' + key + ':' + l1[key], frame) || anyTriggered;
                    anyTriggered = wsEmitter.emit(DEF_CALLBACK_PREFIX + l0 + ',' + key, frame) || anyTriggered;
                }
                anyTriggered = wsEmitter.emit(DEF_CALLBACK_PREFIX + l0 + ',,' + l2, frame) || anyTriggered;
                anyTriggered = wsEmitter.emit(DEF_CALLBACK_PREFIX + l0, frame) || anyTriggered;

                if (!anyTriggered) {
                    logger.debug?.({ unhandled: true, msgId, frame: { tag: l0, attrs: l1, childTag: l2 } }, 'unhandled recv');
                }
            }
        });
    }

    function end(error) {
        if (closed) return;
        closed = true;
        wsOpen = false;
        clearInterval(keepAliveReq);
        clearTimeout(qrTimer);

        wsEmitter.emit('close', error);

        wsEmitter.removeAllListeners();

        if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
            try { ws.close(); } catch {}
        }

        ev.emit('connection.update', {
            connection: 'close',
            lastDisconnect: {
                error,
                date: new Date()
            }
        });
    }

    async function waitForSocketOpen() {
        if (wsOpen) return;
        if (wsClosed) throw new Error('Connection closed');
        return new Promise((resolve, reject) => {
            const onOpen = () => {
                wsEmitter.off('open', onOpen);
                wsEmitter.off('close', onClose);
                resolve();
            };
            const onClose = (err) => {
                wsEmitter.off('open', onOpen);
                wsEmitter.off('close', onClose);
                reject(err || new Error('Connection closed'));
            };
            wsEmitter.on('open', onOpen);
            wsEmitter.on('close', onClose);
        });
    }

    async function logout(reason) {
        const myJid = creds.me?.id;
        if (myJid) {
            try {
                await sendNode({
                    tag: 'iq',
                    attrs: {
                        to: S_WHATSAPP_NET,
                        type: 'set',
                        id: generateMessageTag(),
                        xmlns: 'md'
                    },
                    content: [{
                        tag: 'remove-companion-device',
                        attrs: {
                            jid: myJid,
                            reason: 'user_initiated'
                        }
                    }]
                });
            } catch (err) {
                logger.warn?.({ err }, 'failed to send logout notification');
            }
        }
        end(Object.assign(new Error(reason || 'Intentional Logout'), {
            output: { statusCode: DISCONNECT_REASON.loggedOut }
        }));
    }

    async function executeUSyncQuery(usyncQuery) {
        if (!usyncQuery.protocols || usyncQuery.protocols.length === 0) {
            throw new Error('USyncQuery requires at least one protocol');
        }
        const userNodes = (usyncQuery.users || []).map(user => ({
            tag: 'user',
            attrs: {
                jid: !user.phone ? user.id : undefined
            },
            content: usyncQuery.protocols
                .map(p => p.getUserElement(user))
                .filter(Boolean)
        }));
        const queryPayload = {
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'get',
                xmlns: 'usync'
            },
            content: [{
                tag: 'usync',
                attrs: {
                    context: usyncQuery.context || 'interactive',
                    mode: usyncQuery.mode || 'query',
                    sid: generateMessageTag(),
                    last: 'true',
                    index: '0'
                },
                content: [
                    {
                        tag: 'query',
                        attrs: {},
                        content: usyncQuery.protocols.map(p => p.getQueryElement())
                    },
                    {
                        tag: 'list',
                        attrs: {},
                        content: userNodes
                    }
                ]
            }]
        };
        const response = await query(queryPayload);
        return usyncQuery.parseUSyncQueryResult(response);
    }

    async function onWhatsApp(...phoneNumbers) {
        const uq = new USyncQuery().withContactProtocol();
        let addedAny = false;
        for (const rawJid of phoneNumbers) {
            if (isLidUser(rawJid)) {
                logger.warn?.('LID JIDs are not supported with onWhatsApp');
                continue;
            }
            const cleaned = '+' + rawJid.replace('+', '').split('@')[0].split(':')[0];
            uq.withUser(new USyncUser().withPhone(cleaned));
            addedAny = true;
        }
        if (!addedAny) return [];
        const outcome = await executeUSyncQuery(uq);
        if (!outcome) return [];
        return outcome.list
            .filter(entry => !!entry.contact)
            .map(({ contact, id }) => ({ jid: id, exists: contact }));
    }

    async function getAvailablePreKeysOnServer() {
        const result = await query({
            tag: 'iq',
            attrs: {
                id: generateMessageTag(),
                xmlns: 'encrypt',
                type: 'get',
                to: S_WHATSAPP_NET
            },
            content: [{ tag: 'count', attrs: {} }]
        });
        const countChild = getBinaryNodeChild(result, 'count');
        return +(countChild?.attrs?.value || 0);
    }

    async function uploadPreKeys(count) {
        count = count || MIN_PREKEY_COUNT;
        const preKeys = [];
        for (let i = 0; i < count; i++) {
            const keyId = creds.nextPreKeyId + i;
            const keyPair = Curve.generateKeyPair();
            preKeys.push({ keyId, keyPair });
        }

        const node = {
            tag: 'iq',
            attrs: {
                xmlns: 'encrypt',
                type: 'set',
                to: S_WHATSAPP_NET
            },
            content: [
                {
                    tag: 'registration',
                    attrs: {},
                    content: encodeBigEndian(creds.registrationId)
                },
                {
                    tag: 'type',
                    attrs: {},
                    content: KEY_BUNDLE_TYPE
                },
                {
                    tag: 'identity',
                    attrs: {},
                    content: creds.signedIdentityKey.public
                },
                {
                    tag: 'list',
                    attrs: {},
                    content: preKeys.map(k => ({
                        tag: 'key',
                        attrs: {},
                        content: [
                            { tag: 'id', attrs: {}, content: encodeBigEndian(k.keyId, 3) },
                            { tag: 'value', attrs: {}, content: k.keyPair.public }
                        ]
                    }))
                },
                {
                    tag: 'skey',
                    attrs: {},
                    content: [
                        { tag: 'id', attrs: {}, content: encodeBigEndian(creds.signedPreKey.keyId, 3) },
                        { tag: 'value', attrs: {}, content: creds.signedPreKey.keyPair.public },
                        { tag: 'signature', attrs: {}, content: creds.signedPreKey.signature }
                    ]
                }
            ]
        };

        await query(node);

        const preKeyData = {};
        for (const pk of preKeys) {
            preKeyData[pk.keyId] = pk;
        }
        await authState.keys.set({ 'pre-key': preKeyData });

        creds.nextPreKeyId += count;
        creds.firstUnuploadedPreKeyId = creds.nextPreKeyId;
        ev.emit('creds.update', creds);
    }

    async function digestKeyBundle() {
        const res = await query({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'encrypt' },
            content: [{ tag: 'digest', attrs: {} }]
        });
        const digestNode = getBinaryNodeChild(res, 'digest');
        if (!digestNode) {
            await uploadPreKeys();
            throw new Error('encrypt/get digest returned no digest node');
        }
    }

    async function uploadPreKeysToServerIfRequired() {
        try {
            const preKeyCount = await getAvailablePreKeysOnServer();
            if (preKeyCount < MIN_PREKEY_COUNT) {
                await uploadPreKeys(INITIAL_PREKEY_COUNT);
            }
        } catch (err) {
            logger.error?.({ err }, 'Failed to check/upload pre-keys');
        }
    }

    let qrRef = null;

    function registerQRHandler() {
        wsEmitter.on(DEF_CALLBACK_PREFIX + 'iq,type:set,pair-device', async (stanza) => {
            const iq = {
                tag: 'iq',
                attrs: {
                    to: S_WHATSAPP_NET,
                    type: 'result',
                    id: stanza.attrs.id
                }
            };
            await sendNode(iq);

            const pairDeviceNode = getBinaryNodeChild(stanza, 'pair-device');
            const refNodes = getBinaryNodeChildren(pairDeviceNode, 'ref');
            const noiseKeyB64 = Buffer.from(creds.noiseKey.public).toString('base64');
            const identityKeyB64 = Buffer.from(creds.signedIdentityKey.public).toString('base64');
            const advB64 = creds.advSecretKey;

            let qrMs = qrTimeout || 60000;
            const genPairQR = () => {
                if (!wsOpen) return;
                const refNode = refNodes.shift();
                if (!refNode) {
                    end(new Error('QR refs attempts ended'));
                    return;
                }
                const ref = refNode.content?.toString?.() ||
                           (Buffer.isBuffer(refNode.content)
                            ? refNode.content.toString('utf-8')
                            : String(refNode.content || ''));
                const qr = [ref, noiseKeyB64, identityKeyB64, advB64].join(',');
                ev.emit('connection.update', { qr });
                qrTimer = setTimeout(genPairQR, qrMs);
                qrMs = qrTimeout || 20000;
            };
            genPairQR();
        });

        wsEmitter.on(DEF_CALLBACK_PREFIX + 'iq,,pair-success', async (stanza) => {
            logger.info?.('pair-success received from server');
            try {
                const { reply, creds: updatedCreds } = configureSuccessfulPairing(stanza, creds);
                logger.info?.({ me: updatedCreds.me, platform: updatedCreds.platform }, 'pairing configured successfully, expect to restart the connection...');
                ev.emit('creds.update', updatedCreds);
                ev.emit('connection.update', { isNewLogin: true, qr: undefined });
                await sendNode(reply);
            } catch (error) {
                logger.info?.({ trace: error.stack }, 'error in pairing');
                end(error);
            }
        });
    }


    const { getPlatformId } = require('./wa-browser');

    const requestPairingCode = async (phoneNumber, customPairingCode) => {
        clearTimeout(qrTimer);
        qrTimer = null;

        const pairingCode = customPairingCode ?? bytesToCrockford(nodeCrypto.randomBytes(5));
        if (customPairingCode && customPairingCode?.length !== 8) {
            throw new Error('Custom pairing code must be exactly 8 chars');
        }
        authState.creds.pairingCode = pairingCode;
        authState.creds.me = {
            id: jidEncode(phoneNumber, 's.whatsapp.net'),
            name: '~'
        };
        ev.emit('creds.update', authState.creds);

        const pairingIq = {
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'set',
                id: generateMessageTag(),
                xmlns: 'md'
            },
            content: [
                {
                    tag: 'link_code_companion_reg',
                    attrs: {
                        jid: authState.creds.me.id,
                        stage: 'companion_hello',
                        should_show_push_notification: 'true'
                    },
                    content: [
                        {
                            tag: 'link_code_pairing_wrapped_companion_ephemeral_pub',
                            attrs: {},
                            content: await generatePairingKey()
                        },
                        {
                            tag: 'companion_server_auth_key_pub',
                            attrs: {},
                            content: authState.creds.noiseKey.public
                        },
                        {
                            tag: 'companion_platform_id',
                            attrs: {},
                            content: getPlatformId(browser[1])
                        },
                        {
                            tag: 'companion_platform_display',
                            attrs: {},
                            content: `${browser[1]} (${browser[0]})`
                        },
                        {
                            tag: 'link_code_pairing_nonce',
                            attrs: {},
                            content: '0'
                        }
                    ]
                }
            ]
        };

        await sendNode(pairingIq);
        return authState.creds.pairingCode;
    };

    async function generatePairingKey() {
        const salt = nodeCrypto.randomBytes(32);
        const randomIv = nodeCrypto.randomBytes(16);
        const key = await derivePairingCodeKey(authState.creds.pairingCode, salt);
        const ciphered = aesEncryptCTR(authState.creds.pairingEphemeralKeyPair.public, key, randomIv);
        return Buffer.concat([salt, randomIv, ciphered]);
    }

    async function decipherLinkPublicKey(data) {
        const buffer = toRequiredBuffer(data);
        const salt = buffer.slice(0, 32);
        const secretKey = await derivePairingCodeKey(authState.creds.pairingCode, salt);
        const iv = buffer.slice(32, 48);
        const payload = buffer.slice(48, 80);
        return aesDecryptCTR(payload, secretKey, iv);
    }

    function toRequiredBuffer(data) {
        if (data === undefined) {
            throw new Error('Invalid buffer — expected data but got undefined');
        }
        return data instanceof Buffer ? data : Buffer.from(data);
    }

    const sendWAMBuffer = (wamBuffer) => {
        return query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                id: generateMessageTag(),
                xmlns: 'w:stats'
            },
            content: [
                {
                    tag: 'add',
                    attrs: { t: Math.round(Date.now() / 1000) + '' },
                    content: wamBuffer
                }
            ]
        });
    };

    function registerNotificationHandlers() {
        wsEmitter.on(DEF_CALLBACK_PREFIX + 'notification,type:encrypt', async (node) => {
            const from = node.attrs.from;
            if (from === S_WHATSAPP_NET) {
                const countChild = getBinaryNodeChild(node, 'count');
                if (countChild) {
                    const count = +(countChild.attrs?.value || 0);
                    if (count < MIN_PREKEY_COUNT) {
                        await uploadPreKeys();
                    }
                }
            }
            await sendMessageAck(node);
        });

        wsEmitter.on(DEF_CALLBACK_PREFIX + 'notification,type:link_code_companion_reg', async (node) => {
            logger.info?.('link_code_companion_reg notification received — processing pairing step 2...');
            await sendMessageAck(node);
            try {
                const linkCodeCompanionReg = getBinaryNodeChild(node, 'link_code_companion_reg');
                if (!linkCodeCompanionReg) {
                    logger.error?.('link_code_companion_reg child missing from notification');
                    return;
                }

                const ref = toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, 'link_code_pairing_ref'));
                const primaryIdentityPublicKey = toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, 'primary_identity_pub'));
                const primaryEphemeralPublicKeyWrapped = toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, 'link_code_pairing_wrapped_primary_ephemeral_pub'));

                const codePairingPublicKey = await decipherLinkPublicKey(primaryEphemeralPublicKeyWrapped);

                const companionSharedKey = Curve.sharedKey(authState.creds.pairingEphemeralKeyPair.private, codePairingPublicKey);

                const random = nodeCrypto.randomBytes(32);
                const linkCodeSalt = nodeCrypto.randomBytes(32);
                const linkCodePairingExpanded = await hkdf(companionSharedKey, 32, {
                    salt: linkCodeSalt,
                    info: 'link_code_pairing_key_bundle_encryption_key'
                });

                const encryptPayload = Buffer.concat([
                    Buffer.from(authState.creds.signedIdentityKey.public),
                    primaryIdentityPublicKey,
                    random
                ]);

                const encryptIv = nodeCrypto.randomBytes(12);
                const encrypted = aesEncryptGCM(encryptPayload, linkCodePairingExpanded, encryptIv, Buffer.alloc(0));
                const encryptedPayload = Buffer.concat([linkCodeSalt, encryptIv, encrypted]);

                const identitySharedKey = Curve.sharedKey(authState.creds.signedIdentityKey.private, primaryIdentityPublicKey);

                const identityPayload = Buffer.concat([companionSharedKey, identitySharedKey, random]);
                authState.creds.advSecretKey = (await hkdf(identityPayload, 32, { info: 'adv_secret' })).toString('base64');

                await query({
                    tag: 'iq',
                    attrs: {
                        to: S_WHATSAPP_NET,
                        type: 'set',
                        id: generateMessageTag(),
                        xmlns: 'md'
                    },
                    content: [
                        {
                            tag: 'link_code_companion_reg',
                            attrs: {
                                jid: authState.creds.me.id,
                                stage: 'companion_finish'
                            },
                            content: [
                                {
                                    tag: 'link_code_pairing_wrapped_key_bundle',
                                    attrs: {},
                                    content: encryptedPayload
                                },
                                {
                                    tag: 'companion_identity_public',
                                    attrs: {},
                                    content: authState.creds.signedIdentityKey.public
                                },
                                {
                                    tag: 'link_code_pairing_ref',
                                    attrs: {},
                                    content: ref
                                }
                            ]
                        }
                    ]
                });

                authState.creds.registered = true;
                ev.emit('creds.update', authState.creds);
                logger.info?.('link_code_companion_reg companion_finish sent successfully');
            } catch (err) {
                logger.error?.({ err: err.message, stack: err.stack }, 'failed to process link_code_companion_reg');
            }
        });

        wsEmitter.on(DEF_CALLBACK_PREFIX + 'notification', async (node) => {
            await sendMessageAck(node);
        });

        wsEmitter.on(DEF_CALLBACK_PREFIX + 'message', async (node) => {
            await processIncomingMessage(node);
        });

        wsEmitter.on(DEF_CALLBACK_PREFIX + 'receipt', async (node) => {
            await handleReceipt(node);
        });

        wsEmitter.on(DEF_CALLBACK_PREFIX + 'iq,xmlns:urn:xmpp:ping', async (node) => {
            const responseId = node.attrs.id || generateMessageTag();
            await sendNode({
                tag: 'iq',
                attrs: {
                    to: node.attrs.from || S_WHATSAPP_NET,
                    type: 'result',
                    id: responseId
                }
            }).catch(() => {});
        });

        wsEmitter.on(DEF_CALLBACK_PREFIX + 'ib,,offline_preview', async (node) => {
            logger.info?.('offline preview received');
            await sendNode({
                tag: 'ib',
                attrs: {},
                content: [{ tag: 'offline_batch', attrs: { count: '100' } }]
            });
        });

        wsEmitter.on(DEF_CALLBACK_PREFIX + 'ib,,offline', (node) => {
            const offlineChild = getBinaryNodeChild(node, 'offline');
            const offlineCount = +(offlineChild?.attrs?.count || 0);
            logger.info?.('handled ' + offlineCount + ' offline messages/notifications');
            if (didStartBuffer) {
                ev.flush();
                logger.debug?.('flushed events for initial buffer');
            }
            ev.emit('connection.update', { receivedPendingNotifications: true });
        });

        wsEmitter.on('CB:xmlstreamend', () => {
            const err = new Error('Connection Terminated by Server');
            err.statusCode = DISCONNECT_REASON.connectionClosed;
            end(err);
        });

        wsEmitter.on(DEF_CALLBACK_PREFIX + 'stream:error', (node) => {
            const children = getAllBinaryNodeChildren(node);
            const reasonNode = children[0];
            logger.error?.({ reasonNode, fullErrorNode: node }, 'stream errored out');

            const STREAM_CODE_MAP = { conflict: DISCONNECT_REASON.connectionReplaced };
            let reason = reasonNode?.tag || 'unknown';
            const statusCode = +(node.attrs?.code || STREAM_CODE_MAP[reason] || DISCONNECT_REASON.badSession);
            if (statusCode === DISCONNECT_REASON.restartRequired) {
                reason = 'restart required';
            }

            const err = new Error('Stream Errored (' + reason + ')');
            err.statusCode = statusCode;
            end(err);
        });

        wsEmitter.on(DEF_CALLBACK_PREFIX + 'failure', (node) => {
            const reason = +(node.attrs?.reason || 0);
            const err = new Error('Connection failure: reason ' + reason);
            err.statusCode = reason;
            end(err);
        });

        wsEmitter.on(DEF_CALLBACK_PREFIX + 'ib,,downgrade_webclient', () => {
            end(new Error('Multi-device beta not joined'));
        });

        wsEmitter.on(DEF_CALLBACK_PREFIX + 'ib,,edge_routing', (node) => {
            const edgeRoutingNode = getBinaryNodeChild(node, 'edge_routing');
            const routingInfo = getBinaryNodeChild(edgeRoutingNode, 'routing_info');
            if (routingInfo?.content) {
                authState.creds.routingInfo = Buffer.from(routingInfo.content);
                ev.emit('creds.update', authState.creds);
            }
        });

        wsEmitter.on(DEF_CALLBACK_PREFIX + 'success', async (node) => {
            try {
                await uploadPreKeysToServerIfRequired();
                await sendPassiveIq('active');
                try {
                    await digestKeyBundle();
                } catch (e) {
                    logger.warn?.({ e }, 'failed to run digest after login');
                }
            } catch (err) {
                logger.warn?.({ err }, 'failed to send initial passive iq');
            }
            logger.info?.('opened connection to WA');
            clearTimeout(qrTimer);
            ev.emit('creds.update', { me: { ...authState.creds.me, lid: node?.attrs?.lid } });
            ev.emit('connection.update', { connection: 'open' });

            if (node?.attrs?.lid && authState.creds.me?.id) {
                const myLID = node.attrs.lid;
                process.nextTick(async () => {
                    try {
                        const myPN = authState.creds.me.id;
                        if (signalRepo.lidMapping && signalRepo.lidMapping.storeLIDPNMappings) {
                            await signalRepo.lidMapping.storeLIDPNMappings([{ lid: myLID, pn: myPN }]);
                        }
                        const decoded = jidDecode(myPN);
                        if (decoded) {
                            await authState.keys.set({
                                'device-list': {
                                    [decoded.user]: [(decoded.device || 0).toString()]
                                }
                            });
                        }
                        if (signalRepo.migrateSession) {
                            await signalRepo.migrateSession(myPN, myLID);
                        }
                        logger.info?.({ myPN, myLID }, 'Own LID session created successfully');
                    } catch (lidErr) {
                        logger.error?.({ lidErr, lid: myLID }, 'Failed to create own LID session');
                    }
                });
            }
        });
    }

    async function sendMessageAck(node) {
        const stanza = {
            tag: 'ack',
            attrs: {
                id: node.attrs.id,
                to: node.attrs.from,
                class: node.tag
            }
        };
        if (node.attrs.participant) {
            stanza.attrs.participant = node.attrs.participant;
        }
        if (node.attrs.type) {
            stanza.attrs.type = node.attrs.type;
        }
        await sendNode(stanza).catch(() => {});
    }

    async function processIncomingMessage(node) {
        await sendMessageAck(node);

        const meId = creds.me?.id;
        const meLid = creds.me?.lid;

        try {
            const result = decryptMessageNode(node, meId, meLid, signalRepo, logger);
            await result.decrypt();

            cleanMessage(result.fullMessage, meId, meLid);

            ev.emit('messages.upsert', {
                messages: [result.fullMessage],
                type: 'notify'
            });

            await processMessage(result.fullMessage, {
                ev,
                creds,
                signalRepository: signalRepo,
                logger,
                keys: authState.keys,
                getMessage: async (key) => {
                    return messageStore.get(key.id);
                }
            });
        } catch (err) {
            logger.error?.({ err, from: node.attrs?.from }, 'Error processing incoming message');

            const from = node.attrs.from;
            const participant = node.attrs.participant;
            const isGroup = isJidGroup(from);

            ev.emit('messages.upsert', {
                messages: [{
                    key: {
                        remoteJid: from,
                        fromMe: false,
                        id: node.attrs.id,
                        participant: isGroup ? participant : undefined
                    },
                    messageTimestamp: parseInt(node.attrs.t || '0', 10),
                    pushName: node.attrs.notify || '',
                    messageStubType: 'CIPHERTEXT',
                    messageStubParameters: [err.message || 'decryption failed']
                }],
                type: 'notify'
            });
        }
    }

    async function handleReceipt(node) {
        await sendMessageAck(node);

        const from = node.attrs.from;
        const type = node.attrs.type;
        const ids = [node.attrs.id];
        const recipient = node.attrs.recipient;

        const listNode = getBinaryNodeChild(node, 'list');
        if (listNode) {
            const items = getBinaryNodeChildren(listNode, 'item');
            for (const item of items) {
                if (item.attrs?.id) ids.push(item.attrs.id);
            }
        }

        if (type === 'retry') {
            const msgId = node.attrs.id;
            const retryJid = from;
            const destinationJid = recipient || jidNormalizedUser(from);
            logger?.info?.({ msgId, retryJid, destinationJid }, 'retry receipt received');

            try {
                const cached = messageRetryManager.getRecentMessage(destinationJid, msgId);
                if (!cached) {
                    logger?.warn?.({ msgId, destinationJid }, 'no cached message for retry');
                    return;
                }

                const retryCount = messageRetryManager.incrementRetryCount(msgId);
                if (retryCount > 5) {
                    logger?.warn?.({ msgId, retryCount }, 'exceeded max retries');
                    messageRetryManager.markRetryFailed(msgId);
                    return;
                }

                await msgSocket.assertSessions([retryJid], true);

                const encodedMsg = msgSocket.encodeWAMessage(cached.message);
                const { nodes: participantNodes, shouldIncludeDeviceIdentity } = await msgSocket.createParticipantNodes([retryJid], encodedMsg, {});

                const stanzaContent = [{
                    tag: 'participants',
                    attrs: {},
                    content: participantNodes
                }];

                if (shouldIncludeDeviceIdentity && creds.account) {
                    const { encodeSignedDeviceIdentity } = require('./messages-send');
                    stanzaContent.push({
                        tag: 'device-identity',
                        attrs: {},
                        content: encodeSignedDeviceIdentity(creds.account, true)
                    });
                }

                await sendNode({
                    tag: 'message',
                    attrs: {
                        id: msgId,
                        type: 'text',
                        to: destinationJid,
                    },
                    content: stanzaContent
                });

                logger?.info?.({ msgId, retryJid, retryCount }, 'retry message sent');
            } catch (err) {
                logger?.error?.({ msgId, err: err.message }, 'failed to handle retry');
            }
            return;
        }

        let status;
        switch (type) {
            case 'read': status = 4; break;
            case 'read-self': status = 4; break;
            case 'played': status = 5; break;
            case 'sender': status = 3; break;
            default: status = 3; break;
        }

        ev.emit('messages.update', ids.map(id => ({
            key: { remoteJid: recipient || from, id, fromMe: true },
            update: { status }
        })));
    }

    function generateMessageIDV2(userId) {
        const data = Buffer.alloc(8 + 20 + 16);
        data.writeBigUInt64BE(BigInt(Date.now()), 0);
        if (userId) {
            const decoded = jidDecode(userId);
            if (decoded?.user) {
                const userBytes = Buffer.from(decoded.user, 'utf-8');
                userBytes.copy(data, 8, 0, Math.min(userBytes.length, 20));
            }
        }
        const randBytes = nodeCrypto.randomBytes(16);
        randBytes.copy(data, 28);
        const hash = nodeCrypto.createHash('sha256').update(data).digest();
        return '3EB0' + hash.slice(0, 8).toString('hex').toUpperCase();
    }

    async function sendTextMessage(jid, text, options) {
        options = options || {};
        const proto = loadProto();
        const msgId = options.messageId || generateMessageIDV2(creds.me?.id);

        const message = { conversation: text };

        if (options.quoted) {
            message.extendedTextMessage = {
                text,
                contextInfo: {
                    stanzaId: options.quoted.key?.id,
                    participant: options.quoted.key?.participant || options.quoted.key?.remoteJid,
                    quotedMessage: options.quoted.message
                }
            };
            delete message.conversation;
        }

        const encodedMsg = proto.Message.encode(proto.Message.fromObject(message)).finish();
        const paddedMsg = writeRandomPadMax16(encodedMsg);

        const stanza = {
            tag: 'message',
            attrs: {
                id: msgId,
                to: jid,
                type: 'text'
            },
            content: [
                {
                    tag: 'plaintext',
                    attrs: {},
                    content: paddedMsg
                }
            ]
        };

        await sendNode(stanza);

        const fullMsg = {
            key: {
                remoteJid: jid,
                fromMe: true,
                id: msgId
            },
            message,
            messageTimestamp: Math.floor(Date.now() / 1000),
            status: 1
        };

        ev.emit('messages.upsert', {
            messages: [fullMsg],
            type: 'append'
        });

        return fullMsg;
    }

    async function sendReceipt(jid, participant, messageIds, type) {
        if (!messageIds || messageIds.length === 0) return;

        const node = {
            tag: 'receipt',
            attrs: {
                id: messageIds[0],
                to: jid
            }
        };

        if (type) {
            node.attrs.type = type;
            if (type === 'read' || type === 'read-self') {
                node.attrs.t = Math.floor(Date.now() / 1000).toString();
            }
        }

        if (participant) {
            node.attrs.participant = participant;
        }

        if (messageIds.length > 1) {
            node.content = [{
                tag: 'list',
                attrs: {},
                content: messageIds.slice(1).map(id => ({
                    tag: 'item',
                    attrs: { id }
                }))
            }];
        }

        await sendNode(node);
    }

    async function readMessages(keys) {
        const groups = {};
        for (const key of keys) {
            const groupKey = key.remoteJid + ':' + (key.participant || '');
            if (!groups[groupKey]) {
                groups[groupKey] = {
                    jid: key.remoteJid,
                    participant: key.participant,
                    ids: []
                };
            }
            groups[groupKey].ids.push(key.id);
        }

        for (const group of Object.values(groups)) {
            await sendReceipt(group.jid, group.participant, group.ids, 'read');
        }
    }

    async function sendPresenceUpdate(type, toJid) {
        const node = {
            tag: 'presence',
            attrs: { type }
        };
        if (toJid) {
            node.attrs.to = toJid;
        }
        await sendNode(node);
    }

    async function presenceSubscribe(jid) {
        await sendNode({
            tag: 'presence',
            attrs: {
                to: jid,
                type: 'subscribe'
            }
        });
    }

    async function fetchBlocklist() {
        const result = await query({
            tag: 'iq',
            attrs: {
                xmlns: 'blocklist',
                to: S_WHATSAPP_NET,
                type: 'get'
            }
        });
        const listNode = getBinaryNodeChild(result, 'list');
        const items = getBinaryNodeChildren(listNode, 'item');
        return items.map(i => i.attrs.jid);
    }

    async function updateBlockStatus(jid, action) {
        await query({
            tag: 'iq',
            attrs: {
                xmlns: 'blocklist',
                to: S_WHATSAPP_NET,
                type: 'set'
            },
            content: [{
                tag: 'item',
                attrs: { jid, action }
            }]
        });
    }

    async function fetchStatus(jid) {
        const result = await query({
            tag: 'iq',
            attrs: {
                xmlns: 'status',
                to: S_WHATSAPP_NET,
                type: 'get'
            },
            content: [{
                tag: 'status',
                attrs: {},
                content: [{ tag: 'user', attrs: { jid } }]
            }]
        });
        const statusNode = getBinaryNodeChild(result, 'status');
        const userNode = getBinaryNodeChild(statusNode, 'user');
        return userNode?.content?.toString?.() || '';
    }

    async function updateProfileName(name) {
        await query({
            tag: 'iq',
            attrs: {
                xmlns: 'profile',
                to: S_WHATSAPP_NET,
                type: 'set'
            },
            content: [{
                tag: 'profile',
                attrs: { name }
            }]
        });
    }

    let protoRoot = null;

    function loadProto() {
        if (protoRoot) return protoRoot;
        const protobuf = require('protobufjs');
        const path = require('path');
        const root = protobuf.loadSync(path.join(__dirname, '..', 'proto', 'whatsapp.proto'));
        protoRoot = {
            HandshakeMessage: root.lookupType('proto.HandshakeMessage'),
            ClientPayload: root.lookupType('proto.ClientPayload'),
            DeviceProps: root.lookupType('proto.DeviceProps'),
            Message: root.lookupType('proto.Message'),
            WebMessageInfo: root.lookupType('proto.WebMessageInfo'),
            MessageKey: root.lookupType('proto.MessageKey'),
            ADVSignedDeviceIdentity: root.lookupType('proto.ADVSignedDeviceIdentity'),
            ADVSignedDeviceIdentityHMAC: root.lookupType('proto.ADVSignedDeviceIdentityHMAC'),
            ADVDeviceIdentity: root.lookupType('proto.ADVDeviceIdentity')
        };
        return protoRoot;
    }

    wsEmitter.on('open', async () => {
        try {
            if (!userVersion) {
                const fetched = await fetchLatestWaWebVersion().catch(() => null);
                if (fetched?.version) {
                    version = fetched.version;
                    socketConfig.version = version;
                    if (logger !== console) {
                        logger.info?.({ version, isLatest: !!fetched.isLatest }, 'resolved WA Web version');
                    }
                }
            }
            await validateConnection();
        } catch (err) {
            end(err);
        }
    });

    wsEmitter.on('message', (data) => {
        onMessageReceived(data).catch(err => {
            logger.error?.({ err }, 'error in processing message');
        });
    });

    wsEmitter.on('close', (code) => {
        end(new Error('WebSocket closed: ' + code));
    });

    wsEmitter.on('error', (err) => {
        end(err);
    });

    registerQRHandler();
    registerNotificationHandlers();

    ev.on('creds.update', update => {
        const name = update.me?.name;
        if (creds.me?.name !== name && name) {
            logger.debug?.({ name }, 'updated pushName');
            sendNode({
                tag: 'presence',
                attrs: { name }
            }).catch(err => {
                logger.warn?.({ trace: err.stack }, 'error in sending presence update on name change');
            });
        }
        Object.assign(creds, update);
    });

    let didStartBuffer = false;
    process.nextTick(() => {
        if (creds.me?.id) {
            ev.buffer();
            didStartBuffer = true;
        }
        ev.emit('connection.update', { connection: 'connecting', receivedPendingNotifications: false, qr: undefined });
    });

    const msgSocket = makeMessagesSocket({
        ev,
        authState,
        query,
        sendNode,
        generateMessageTag,
        logger,
        signalRepository: signalRepo
    });

    const groupSocket = makeGroupsSocket({ query, generateMessageTag });

    const newsletterSocket = makeNewsletterSocket({ query, generateMessageTag });

    const _communityUpsertRef = { fn: null };
    const communitySocket = makeCommunitiesSocket({
        query,
        generateMessageTag,
        groupMetadata: groupSocket.groupMetadata,
        ev,
        authState,
        upsertMessage: (...args) => _communityUpsertRef.fn?.(...args)
    });

    const chatsSocket = makeChatsSocket({
        ev,
        authState,
        query,
        sendNode,
        generateMessageTag,
        logger,
        signalRepository: signalRepo,
        options: config?.options,
        getMessage: async (key) => messageStore.get(key.id),
        shouldSyncHistoryMessage: config?.shouldSyncHistoryMessage,
        shouldIgnoreJid: config?.shouldIgnoreJid,
        markOnlineOnConnect: config?.markOnlineOnConnect,
        fireInitQueries: config?.fireInitQueries,
        appStateMacVerification: config?.appStateMacVerification,
        emitOwnEvents: config?.emitOwnEvents,
        placeholderResendCache: config?.placeholderResendCache
    });

    const partialSock = {
        authState,
        query,
        waUploadToServer: msgSocket.waUploadToServer
    };
    const businessSocket = makeBusinessSocket(config || {}, partialSock);

    _communityUpsertRef.fn = chatsSocket.upsertMessage;

    const { MessageRetryManager } = require('./message-retry');
    const messageRetryManager = new MessageRetryManager(logger, config?.maxMsgRetryCount || 5);

    function onUnexpectedError(err, context) {
        if (logger && logger.error) {
            logger.error({ err }, 'unexpected error in \'' + (context || 'unknown') + '\'');
        }
    }

    async function rotateSignedPreKey() {
        const currentId = creds.signedPreKey?.keyId || 0;
        const nextId = currentId + 1;
        const newKey = signedKeyPair(creds.signedIdentityKey, nextId);
        await query({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'encrypt' },
            content: [{
                tag: 'rotate',
                attrs: {},
                content: [msgSocket.xmppSignedPreKey
                    ? msgSocket.xmppSignedPreKey(newKey)
                    : {
                        tag: 'skey',
                        attrs: {},
                        content: [
                            { tag: 'id', attrs: {}, content: encodeBigEndian(newKey.keyId, 3) },
                            { tag: 'value', attrs: {}, content: newKey.keyPair.public },
                            { tag: 'signature', attrs: {}, content: newKey.signature }
                        ]
                    }]
            }]
        });
        ev.emit('creds.update', { signedPreKey: newKey });
    }

    ev.on('messages.upsert', ({ messages }) => {
        for (const msg of messages) {
            if (msg.key?.id && msg.message) {
                messageStore.set(msg.key.id, msg.message);
                messageRetryManager.addRecentMessage(
                    msg.key.remoteJid || '',
                    msg.key.id,
                    msg.message
                );
            }
        }
    });

    return {
        ev,
        ws: wsEmitter,
        authState,
        query,
        sendNode,
        sendRawMessage,
        generateMessageTag,
        end,
        onUnexpectedError,
        rotateSignedPreKey,
        waitForConnectionUpdate: bindWaitForConnectionUpdate(ev),
        messageRetryManager,
        get user() { return creds.me; },
        get authInfo() { return creds; },

        sendTextMessage,
        requestPairingCode,
        logout,
        onWhatsApp,
        executeUSyncQuery,
        waitForMessage,
        waitForSocketOpen,

        sendMessage: msgSocket.sendMessage,
        relayMessage: msgSocket.relayMessage,
        sendReceipt: msgSocket.sendReceipt,
        sendReadReceipt: msgSocket.sendReadReceipt,
        readMessages: msgSocket.readMessages,
        sendRetryRequest: msgSocket.sendRetryRequest,
        sendPresenceUpdate: msgSocket.sendPresenceUpdate,
        presenceSubscribe: msgSocket.presenceSubscribe,
        sendTyping: msgSocket.sendTyping,
        sendWAMBuffer: msgSocket.sendWAMBuffer,
        fetchBlocklist: msgSocket.fetchBlocklist,
        updateBlockStatus: msgSocket.updateBlockStatus,
        fetchStatus: msgSocket.fetchStatus,
        fetchProfilePictureUrl: msgSocket.fetchProfilePictureUrl,
        updateProfilePicture: msgSocket.updateProfilePicture,
        removeProfilePicture: msgSocket.removeProfilePicture,
        updateProfileName: msgSocket.updateProfileName,
        updateProfileStatus: msgSocket.updateProfileStatus,
        refreshMediaConn: msgSocket.refreshMediaConn,
        waUploadToServer: msgSocket.waUploadToServer,
        assertSessions: msgSocket.assertSessions,
        getUSyncDevices: msgSocket.getUSyncDevices,
        uploadPreKeysToServerIfRequired: msgSocket.uploadPreKeysToServerIfRequired,
        encryptAndUploadMedia: msgSocket.encryptAndUploadMedia,
        sendReceipts: msgSocket.sendReceipts,
        getPrivacyTokens: msgSocket.getPrivacyTokens,
        sendPeerDataOperationMessage: msgSocket.sendPeerDataOperationMessage,
        updateMediaMessage: msgSocket.updateMediaMessage,
        fetchMessageHistory: msgSocket.fetchMessageHistory,
        requestPlaceholderResend: msgSocket.requestPlaceholderResend,

        groupMetadata: groupSocket.groupMetadata,
        groupCreate: groupSocket.groupCreate,
        groupLeave: groupSocket.groupLeave,
        groupUpdateSubject: groupSocket.groupUpdateSubject,
        groupUpdateDescription: groupSocket.groupUpdateDescription,
        groupSettingUpdate: groupSocket.groupSettingUpdate,
        groupParticipantsUpdate: groupSocket.groupParticipantsUpdate,
        groupInviteCode: groupSocket.groupInviteCode,
        groupRevokeInvite: groupSocket.groupRevokeInvite,
        groupAcceptInvite: groupSocket.groupAcceptInvite,
        groupFetchAllParticipating: groupSocket.groupFetchAllParticipating,
        groupToggleEphemeral: groupSocket.groupToggleEphemeral,
        groupGetInviteInfo: groupSocket.groupGetInviteInfo,
        groupAcceptInviteV4: groupSocket.groupAcceptInviteV4,
        groupRevokeInviteV4: groupSocket.groupRevokeInviteV4,
        groupRequestParticipantsList: groupSocket.groupRequestParticipantsList,
        groupRequestParticipantsUpdate: groupSocket.groupRequestParticipantsUpdate,
        groupJoinApprovalMode: groupSocket.groupJoinApprovalMode,
        groupMemberAddMode: groupSocket.groupMemberAddMode,

        newsletterCreate: newsletterSocket.newsletterCreate,
        newsletterUpdate: newsletterSocket.newsletterUpdate,
        newsletterSubscribers: newsletterSocket.newsletterSubscribers,
        newsletterMetadata: newsletterSocket.newsletterMetadata,
        newsletterFollow: newsletterSocket.newsletterFollow,
        newsletterUnfollow: newsletterSocket.newsletterUnfollow,
        newsletterMute: newsletterSocket.newsletterMute,
        newsletterUnmute: newsletterSocket.newsletterUnmute,
        newsletterUpdateName: newsletterSocket.newsletterUpdateName,
        newsletterUpdateDescription: newsletterSocket.newsletterUpdateDescription,
        newsletterUpdatePicture: newsletterSocket.newsletterUpdatePicture,
        newsletterRemovePicture: newsletterSocket.newsletterRemovePicture,
        newsletterReactMessage: newsletterSocket.newsletterReactMessage,
        newsletterFetchMessages: newsletterSocket.newsletterFetchMessages,
        subscribeNewsletterUpdates: newsletterSocket.subscribeNewsletterUpdates,
        newsletterAdminCount: newsletterSocket.newsletterAdminCount,
        newsletterChangeOwner: newsletterSocket.newsletterChangeOwner,
        newsletterDemote: newsletterSocket.newsletterDemote,
        newsletterDelete: newsletterSocket.newsletterDelete,

        communityMetadata: communitySocket.communityMetadata,
        communityCreate: communitySocket.communityCreate,
        communityCreateGroup: communitySocket.communityCreateGroup,
        communityLeave: communitySocket.communityLeave,
        communityUpdateSubject: communitySocket.communityUpdateSubject,
        communityLinkGroup: communitySocket.communityLinkGroup,
        communityUnlinkGroup: communitySocket.communityUnlinkGroup,
        communityFetchLinkedGroups: communitySocket.communityFetchLinkedGroups,
        communityFetchAllParticipating: communitySocket.communityFetchAllParticipating,
        communityUpdateDescription: communitySocket.communityUpdateDescription,
        communityUpdatePicture: communitySocket.communityUpdatePicture,
        communityDeactivate: communitySocket.communityDeactivate,
        communityInviteCode: communitySocket.communityInviteCode,
        communityRevokeInvite: communitySocket.communityRevokeInvite,
        communityAcceptInvite: communitySocket.communityAcceptInvite,
        communityAcceptInviteV4: communitySocket.communityAcceptInviteV4,
        communityGetInviteInfo: communitySocket.communityGetInviteInfo,
        communityRevokeInviteV4: communitySocket.communityRevokeInviteV4,
        communityRequestParticipantsList: communitySocket.communityRequestParticipantsList,
        communityRequestParticipantsUpdate: communitySocket.communityRequestParticipantsUpdate,
        communityParticipantsUpdate: communitySocket.communityParticipantsUpdate,
        communityToggleEphemeral: communitySocket.communityToggleEphemeral,
        communitySettingUpdate: communitySocket.communitySettingUpdate,
        communityMemberAddMode: communitySocket.communityMemberAddMode,
        communityJoinApprovalMode: communitySocket.communityJoinApprovalMode,

        updateBusinessProfile: businessSocket.updateBusinessProfile,
        getBusinessProfile: businessSocket.getBusinessProfile,
        updateCoverPhoto: businessSocket.updateCoverPhoto,
        removeCoverPhoto: businessSocket.removeCoverPhoto,
        getCatalog: businessSocket.getCatalog,
        getCollections: businessSocket.getCollections,
        productCollectionCreate: businessSocket.productCollectionCreate,
        getOrderDetails: businessSocket.getOrderDetails,
        productCreate: businessSocket.productCreate,
        productUpdate: businessSocket.productUpdate,
        productDelete: businessSocket.productDelete,
        getLabels: businessSocket.getLabels,
        createLabel: businessSocket.createLabel,
        updateLabel: businessSocket.updateLabel,
        deleteLabel: businessSocket.deleteLabel,
        labelAssociations: businessSocket.labelAssociations,

        processingMutex: chatsSocket.processingMutex,
        fetchPrivacySettings: chatsSocket.fetchPrivacySettings,
        updateLastSeenPrivacy: chatsSocket.updateLastSeenPrivacy,
        updateOnlinePrivacy: chatsSocket.updateOnlinePrivacy,
        updateProfilePicturePrivacy: chatsSocket.updateProfilePicturePrivacy,
        updateStatusPrivacy: chatsSocket.updateStatusPrivacy,
        updateReadReceiptsPrivacy: chatsSocket.updateReadReceiptsPrivacy,
        updateGroupsAddPrivacy: chatsSocket.updateGroupsAddPrivacy,
        updateDefaultDisappearingMode: chatsSocket.updateDefaultDisappearingMode,
        updateMessagesPrivacy: chatsSocket.updateMessagesPrivacy,
        updateCallPrivacy: chatsSocket.updateCallPrivacy,
        fetchDisappearingDuration: chatsSocket.fetchDisappearingDuration,
        getBotListV2: chatsSocket.getBotListV2,
        rejectCall: chatsSocket.rejectCall,
        profilePictureUrl: chatsSocket.profilePictureUrl,
        cleanDirtyBits: chatsSocket.cleanDirtyBits,
        newAppStateChunkHandler: chatsSocket.newAppStateChunkHandler,
        resyncAppState: chatsSocket.resyncAppState,
        appPatch: chatsSocket.appPatch,
        chatModify: chatsSocket.chatModify,
        updateDisableLinkPreviewsPrivacy: chatsSocket.updateDisableLinkPreviewsPrivacy,
        star: chatsSocket.star,
        addOrEditContact: chatsSocket.addOrEditContact,
        removeContact: chatsSocket.removeContact,
        addLabel: chatsSocket.addLabel,
        addChatLabel: chatsSocket.addChatLabel,
        removeChatLabel: chatsSocket.removeChatLabel,
        addMessageLabel: chatsSocket.addMessageLabel,
        removeMessageLabel: chatsSocket.removeMessageLabel,
        addOrEditQuickReply: chatsSocket.addOrEditQuickReply,
        removeQuickReply: chatsSocket.removeQuickReply,
        fetchProps: chatsSocket.fetchProps,
        executeInitQueries: chatsSocket.executeInitQueries,
        handlePresenceUpdate: chatsSocket.handlePresenceUpdate,
        createCallLink: chatsSocket.createCallLink,
        upsertMessage: chatsSocket.upsertMessage,

        downloadMediaMessage: (msg, type, opts) => downloadMediaMessage(msg, type, opts, {
            logger,
            reuploadRequest: async (msg) => msg
        }),
        downloadContentFromMessage,

        createParticipantNodes: msgSocket.createParticipantNodes,
        assertSessions: msgSocket.assertSessions,
        getUSyncDevices: msgSocket.getUSyncDevices,

        signalRepository: signalRepo,
        messageStore,
    };
}

module.exports = { makeSocket, generateMdTagPrefix };
