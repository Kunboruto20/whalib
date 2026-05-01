'use strict';

const path = require('path');
const {
    getBinaryNodeChild,
    getBinaryNodeChildren,
    getBinaryNodeChildBuffer,
    getBinaryNodeChildUInt,
    encodeBinaryNode,
    assertNodeErrorFree
} = require('./binary-node');
const {
    jidDecode,
    jidEncode,
    jidNormalizedUser,
    isJidGroup,
    isJidStatusBroadcast,
    isJidNewsletter,
    isLidUser,
    isPnUser,
    areJidsSameUser,
    S_WHATSAPP_NET,
    WAJIDDomains
} = require('./jid-utils');
const {
    Curve,
    generateSignalPubKey,
    writeRandomPadMax16,
    unpadRandomMax16,
    encodeBigEndian,
    hmacSign,
    sha256,
    KEY_BUNDLE_TYPE
} = require('./crypto-utils');
const { generateMessageIDV2, encryptedStream, getWAUploadToServer, MEDIA_PATH_MAP, toBuffer, encryptMediaRetryRequest, decryptMediaRetryData, assertMediaContent, getUrlFromDirectPath } = require('./messages-media');
const { getContentType, extractMessageContent, normalizeMessageContent, loadProto, aggregateMessageKeysNotFromMe } = require('./messages');
const { unixTimestampSeconds, bindWaitForEvent, makeMutex, makeKeyedMutex, generateParticipantHashV2 } = require('./generics');

const MIN_PREKEY_COUNT = 5;
const INITIAL_PREKEY_COUNT = 30;

function getMediaType(message) {
    if (message.imageMessage) return 'image';
    if (message.videoMessage) return message.videoMessage.gifPlayback ? 'gif' : 'video';
    if (message.audioMessage) return message.audioMessage.ptt ? 'ptt' : 'audio';
    if (message.contactMessage) return 'vcard';
    if (message.documentMessage) return 'document';
    if (message.contactsArrayMessage) return 'contact_array';
    if (message.liveLocationMessage) return 'livelocation';
    if (message.stickerMessage) return 'sticker';
    if (message.listMessage) return 'list';
    if (message.listResponseMessage) return 'list_response';
    if (message.buttonsResponseMessage) return 'buttons_response';
    if (message.orderMessage) return 'order';
    if (message.productMessage) return 'product';
    if (message.interactiveResponseMessage) return 'native_flow_response';
    return '';
}

function getMessageType(message) {
    if (message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3) return 'poll';
    if (message.eventMessage) return 'event';
    if (getMediaType(message) !== '') return 'media';
    return 'text';
}

function chunk(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

function createSignalIdentity(wid, accountSignatureKey) {
    return {
        identifier: { name: wid, deviceId: 0 },
        identifierKey: generateSignalPubKey(accountSignatureKey)
    };
}

function getPreKeys(keys, min, limit) {
    const idList = [];
    for (let id = min; id < limit; id++) {
        idList.push(id.toString());
    }
    return keys.get('pre-key', idList);
}

function generateOrGetPreKeys(creds, range) {
    const available = creds.nextPreKeyId - creds.firstUnuploadedPreKeyId;
    const remaining = range - available;
    const lastPreKeyId = creds.nextPreKeyId + remaining - 1;
    const newPreKeys = {};
    if (remaining > 0) {
        for (let i = creds.nextPreKeyId; i <= lastPreKeyId; i++) {
            newPreKeys[i] = Curve.generateKeyPair();
        }
    }
    return {
        newPreKeys,
        lastPreKeyId,
        preKeysRange: [creds.firstUnuploadedPreKeyId, range]
    };
}

function xmppSignedPreKey(key) {
    return {
        tag: 'skey',
        attrs: {},
        content: [
            { tag: 'id', attrs: {}, content: encodeBigEndian(key.keyId, 3) },
            { tag: 'value', attrs: {}, content: key.keyPair.public },
            { tag: 'signature', attrs: {}, content: key.signature }
        ]
    };
}

function xmppPreKey(pair, id) {
    return {
        tag: 'key',
        attrs: {},
        content: [
            { tag: 'id', attrs: {}, content: encodeBigEndian(id, 3) },
            { tag: 'value', attrs: {}, content: pair.public }
        ]
    };
}

async function parseAndInjectE2ESessions(node, repository) {
    const extractKey = (key) => key
        ? {
            keyId: getBinaryNodeChildUInt(key, 'id', 3),
            publicKey: generateSignalPubKey(getBinaryNodeChildBuffer(key, 'value')),
            signature: getBinaryNodeChildBuffer(key, 'signature')
        }
        : undefined;

    const listNode = getBinaryNodeChild(node, 'list');
    const nodes = getBinaryNodeChildren(listNode || node, 'user');

    for (const userNode of nodes) {
        try {
            assertNodeErrorFree(userNode);
        } catch {
            continue;
        }
    }

    const chunkSize = 100;
    const chunks_arr = chunk(nodes, chunkSize);
    for (const nodesChunk of chunks_arr) {
        for (const userNode of nodesChunk) {
            const signedKey = getBinaryNodeChild(userNode, 'skey');
            const key = getBinaryNodeChild(userNode, 'key');
            const identity = getBinaryNodeChildBuffer(userNode, 'identity');
            const jid = userNode.attrs.jid;
            const registrationId = getBinaryNodeChildUInt(userNode, 'registration', 4);

            await repository.injectE2ESession({
                jid,
                session: {
                    registrationId,
                    identityKey: generateSignalPubKey(identity),
                    signedPreKey: extractKey(signedKey),
                    preKey: extractKey(key)
                }
            });
        }
    }
}

function extractDeviceJids(result, myJid, myLid, excludeZeroDevices) {
    const decoded = jidDecode(myJid);
    const myUser = decoded?.user;
    const myDevice = decoded?.device || 0;
    const extracted = [];

    for (const userResult of result) {
        const { devices, id } = userResult;
        const dec = jidDecode(id);
        if (!dec) continue;
        const { user, server } = dec;
        let { domainType } = dec;
        const deviceList = devices?.deviceList;
        if (!Array.isArray(deviceList)) continue;

        for (const { id: device, keyIndex, isHosted } of deviceList) {
            if (
                (!excludeZeroDevices || device !== 0) &&
                ((myUser !== user && myLid !== user) || myDevice !== device) &&
                (device === 0 || !!keyIndex)
            ) {
                if (isHosted) {
                    domainType = domainType === WAJIDDomains.LID ? WAJIDDomains.HOSTED_LID : WAJIDDomains.HOSTED;
                }

                let targetServer = server;
                if (domainType === WAJIDDomains.LID) targetServer = 'lid';
                else if (domainType === WAJIDDomains.HOSTED) targetServer = 's.whatsapp.net';
                else if (domainType === WAJIDDomains.HOSTED_LID) targetServer = 'lid';

                extracted.push({
                    user,
                    device,
                    domainType,
                    server: targetServer
                });
            }
        }
    }
    return extracted;
}

async function getNextPreKeys(state, count) {
    const { creds, keys } = state;
    const { newPreKeys, lastPreKeyId, preKeysRange } = generateOrGetPreKeys(creds, count);
    const update = {
        nextPreKeyId: Math.max(lastPreKeyId + 1, creds.nextPreKeyId),
        firstUnuploadedPreKeyId: Math.max(creds.firstUnuploadedPreKeyId, lastPreKeyId + 1)
    };
    await keys.set({ 'pre-key': newPreKeys });
    const preKeys = await getPreKeys(keys, preKeysRange[0], preKeysRange[0] + preKeysRange[1]);
    return { update, preKeys };
}

async function getNextPreKeysNode(state, count) {
    const { creds } = state;
    const { update, preKeys } = await getNextPreKeys(state, count);
    const node = {
        tag: 'iq',
        attrs: {
            xmlns: 'encrypt',
            type: 'set',
            to: S_WHATSAPP_NET
        },
        content: [
            { tag: 'registration', attrs: {}, content: encodeBigEndian(creds.registrationId) },
            { tag: 'type', attrs: {}, content: KEY_BUNDLE_TYPE },
            { tag: 'identity', attrs: {}, content: creds.signedIdentityKey.public },
            { tag: 'list', attrs: {}, content: Object.keys(preKeys).map(k => xmppPreKey(preKeys[+k], +k)) },
            xmppSignedPreKey(creds.signedPreKey)
        ]
    };
    return { update, node };
}

function encodeSignedDeviceIdentity(account, includeSignatureKey) {
    const proto = loadProto();
    const identity = {
        details: account.details,
        accountSignatureKey: account.accountSignatureKey,
        accountSignature: account.accountSignature,
    };
    if (includeSignatureKey) {
        identity.deviceSignature = account.deviceSignature;
    }
    const ADVSignedDeviceIdentity = proto.ADVSignedDeviceIdentity || proto.Message;
    if (ADVSignedDeviceIdentity && ADVSignedDeviceIdentity.encode) {
        return ADVSignedDeviceIdentity.encode(ADVSignedDeviceIdentity.fromObject(identity)).finish();
    }
    return Buffer.from(JSON.stringify(identity));
}

function makeMessagesSocket({ ev, authState, query, sendNode, generateMessageTag, logger, signalRepository }) {
    const { creds, keys } = authState;

    const relayMutex = makeKeyedMutex();
    const sessionAssertMutex = makeMutex();
    const encryptMutex = makeKeyedMutex();

    let mediaConn = null;
    let mediaConnPromise = null;
    const usyncDeviceCache = new Map();
    const usyncDeviceInflight = new Map();
    const usyncDevicePerUserCache = new Map();
    const usyncDevicePerUserInflight = new Map();
    const groupParticipantsCache = new Map();
    const groupParticipantsInflight = new Map();
    const USYNC_DEVICES_TTL_MS = 30000;
    const GROUP_PARTICIPANTS_TTL_MS = 15000;

    function cacheLookup(map, key, ttlMs) {
        const entry = map.get(key);
        if (!entry) return null;
        if (Date.now() - entry.ts > ttlMs) {
            map.delete(key);
            return null;
        }
        return entry.value;
    }

    function cacheWrite(map, key, value) {
        map.set(key, { value, ts: Date.now() });
    }

    async function refreshMediaConn(forceGet) {
        if (!mediaConn || forceGet || (mediaConn.fetchDate && Date.now() - mediaConn.fetchDate > 600000)) {
            if (!mediaConnPromise || forceGet) {
                mediaConnPromise = (async () => {
                    const result = await query({
                        tag: 'iq',
                        attrs: {
                            type: 'set',
                            xmlns: 'w:m',
                            to: S_WHATSAPP_NET
                        },
                        content: [{ tag: 'media_conn', attrs: {} }]
                    });
                    const mediaConnNode = getBinaryNodeChild(result, 'media_conn');
                    if (!mediaConnNode) throw new Error('No media_conn in response');
                    const conn = {
                        auth: mediaConnNode.attrs.auth,
                        ttl: +(mediaConnNode.attrs.ttl || 0),
                        hosts: getBinaryNodeChildren(mediaConnNode, 'host').map(h => ({
                            hostname: h.attrs.hostname,
                            maxContentLengthBytes: +(h.attrs.maxContentLengthBytes || 0)
                        })),
                        fetchDate: Date.now()
                    };
                    mediaConn = conn;
                    return conn;
                })();
            }
            return mediaConnPromise;
        }
        return mediaConn;
    }

    const waUploadToServer = getWAUploadToServer({ logger }, refreshMediaConn);

    async function getUSyncDevices(jids, useCache, ignoreZeroDevices) {
        const normalizedJids = [...new Set(jids.map(j => jidNormalizedUser(j)).filter(Boolean))].sort();
        const cacheKey = `${ignoreZeroDevices ? 'z1' : 'z0'}|${normalizedJids.join(',')}`;
        if (useCache) {
            const cached = cacheLookup(usyncDeviceCache, cacheKey, USYNC_DEVICES_TTL_MS);
            if (cached) return cached;
            const inflight = usyncDeviceInflight.get(cacheKey);
            if (inflight) return inflight;
        }

        const fetchPromise = (async () => {
            const deviceResults = [];
            const perUserPrefix = ignoreZeroDevices ? 'z1' : 'z0';
            const networkTargets = [];
            const inflightPromises = [];

            for (const normalizedJid of normalizedJids) {
                const perUserKey = `${perUserPrefix}|${normalizedJid}`;
                if (useCache) {
                    const cachedUser = cacheLookup(usyncDevicePerUserCache, perUserKey, USYNC_DEVICES_TTL_MS);
                    if (cachedUser) {
                        deviceResults.push(cachedUser);
                        continue;
                    }
                    const inflightUser = usyncDevicePerUserInflight.get(perUserKey);
                    if (inflightUser) {
                        inflightPromises.push(inflightUser);
                        continue;
                    }
                }
                networkTargets.push(normalizedJid);
            }

            if (inflightPromises.length) {
                deviceResults.push(...(await Promise.all(inflightPromises)));
            }

            if (networkTargets.length) {
                const users = networkTargets.map(jid => ({ tag: 'user', attrs: { jid } }));
                const networkPromise = (async () => {
                    const result = await query({
                        tag: 'iq',
                        attrs: {
                            to: S_WHATSAPP_NET,
                            type: 'get',
                            xmlns: 'usync'
                        },
                        content: [{
                            tag: 'usync',
                            attrs: {
                                sid: generateMessageTag(),
                                mode: 'query',
                                last: 'true',
                                index: '0',
                                context: 'message'
                            },
                            content: [
                                { tag: 'query', attrs: {}, content: [{ tag: 'devices', attrs: { version: '2' } }] },
                                { tag: 'list', attrs: {}, content: users }
                            ]
                        }]
                    });

                    const usyncNode = getBinaryNodeChild(result, 'usync');
                    const listNode = getBinaryNodeChild(usyncNode, 'list');
                    const userNodes = getBinaryNodeChildren(listNode || usyncNode || result, 'user');
                    return userNodes.map(userNode => {
                        const jid = userNode.attrs?.jid;
                        const devicesNode = getBinaryNodeChild(userNode, 'devices');
                        const deviceListNode = getBinaryNodeChild(devicesNode, 'device-list');
                        const deviceNodes = getBinaryNodeChildren(deviceListNode || devicesNode || userNode, 'device');
                        const deviceList = deviceNodes.map(d => ({
                            id: +(d.attrs?.id || 0),
                            keyIndex: +(d.attrs?.['key-index'] || 0),
                            isHosted: d.attrs?.hosted === 'true'
                        }));
                        return { id: jid, devices: { deviceList } };
                    });
                })();

                if (useCache) {
                    for (const jid of networkTargets) {
                        const key = `${perUserPrefix}|${jid}`;
                        const single = networkPromise.then(rows => rows.find(r => r.id === jid) || { id: jid, devices: { deviceList: [] } });
                        usyncDevicePerUserInflight.set(key, single);
                    }
                }

                try {
                    const fetched = await networkPromise;
                    deviceResults.push(...fetched);
                    if (useCache) {
                        for (const row of fetched) {
                            cacheWrite(usyncDevicePerUserCache, `${perUserPrefix}|${row.id}`, row);
                        }
                    }
                } finally {
                    if (useCache) {
                        for (const jid of networkTargets) {
                            usyncDevicePerUserInflight.delete(`${perUserPrefix}|${jid}`);
                        }
                    }
                }
            }

            if (useCache) {
                cacheWrite(usyncDeviceCache, cacheKey, deviceResults);
            }
            return deviceResults;
        })();

        if (!useCache) return fetchPromise;
        usyncDeviceInflight.set(cacheKey, fetchPromise);
        try {
            return await fetchPromise;
        } finally {
            usyncDeviceInflight.delete(cacheKey);
        }
    }

    async function assertSessions(jids, force) {
        return sessionAssertMutex.mutex(async () => {
            let didFetchNew = false;
            const jidsRequiringFetch = [];

            if (force) {
                jidsRequiringFetch.push(...jids);
            } else {
                const sessionsAvailable = await keys.get('session', jids.map(jid => {
                    const decoded = jidDecode(jid);
                    return decoded ? `${decoded.user}:${decoded.device || 0}` : jid;
                }));
                for (let i = 0; i < jids.length; i++) {
                    const key = Object.keys(sessionsAvailable)[i];
                    if (!sessionsAvailable[key]) {
                        jidsRequiringFetch.push(jids[i]);
                    }
                }
            }

            if (jidsRequiringFetch.length) {
                const result = await query({
                    tag: 'iq',
                    attrs: {
                        xmlns: 'encrypt',
                        type: 'get',
                        to: S_WHATSAPP_NET
                    },
                    content: [{
                        tag: 'key',
                        attrs: {},
                        content: jidsRequiringFetch.map(jid => ({
                            tag: 'user',
                            attrs: { jid }
                        }))
                    }]
                });

                await parseAndInjectE2ESessions(result, signalRepository);
                didFetchNew = true;
            }

            return didFetchNew;
        });
    }

    async function createParticipantNodes(jids, message, extraAttrs) {
        let shouldIncludeDeviceIdentity = false;
        const patched = await Promise.all(
            jids.map(async (jid) => {
                const enc = await encryptMutex.mutex(jid, async () => signalRepository.encryptMessage({ jid, data: message }));
                if (enc.type === 'pkmsg') {
                    shouldIncludeDeviceIdentity = true;
                }

                return {
                    tag: 'to',
                    attrs: { jid },
                    content: [{
                        tag: 'enc',
                        attrs: {
                            v: '2',
                            type: enc.type,
                            ...extraAttrs
                        },
                        content: enc.ciphertext
                    }]
                };
            })
        );
        return { nodes: patched, shouldIncludeDeviceIdentity };
    }

    async function encryptGroupMessage(group, meId, msgBuffer) {
        const enc = await signalRepository.encryptGroupMessage({
            group,
            meId: jidNormalizedUser(meId),
            data: msgBuffer
        });
        return enc;
    }

    function encodeWAMessage(msg) {
        const proto = loadProto();
        const Message = proto.Message;
        const encoded = Message.encode(Message.fromObject(msg)).finish();
        return Buffer.from(encoded);
    }

    async function relayMessage(jid, message, options) {
        return relayMutex.mutex(jid, async () => {
            options = options || {};
            const msgId = options.messageId || generateMessageIDV2(creds.me?.id);
            const meJid = jidNormalizedUser(creds.me?.id);

            const encodedMsg = encodeWAMessage(message);

            if (isJidGroup(jid)) {
                return await relayGroupMessage(jid, encodedMsg, message, msgId, meJid, options);
            } else if (isJidStatusBroadcast(jid)) {
                return await relayStatusBroadcast(jid, encodedMsg, message, msgId, meJid, options);
            } else {
                return await relay1to1Message(jid, encodedMsg, message, msgId, meJid, options);
            }
        });
    }

    async function relay1to1Message(jid, encodedMsg, message, msgId, meJid, options) {
        const normalizedJid = jidNormalizedUser(jid);
        const meFullJid = creds.me?.id;
        const meLid = creds.me?.lid;

        const senderIdentity = jidEncode(jidDecode(meFullJid)?.user, 's.whatsapp.net', undefined);
        const sessionDevices = await getUSyncDevices([senderIdentity, normalizedJid], true, false);

        const { user: mePnUser } = jidDecode(meFullJid);
        const { user: meLidUser } = meLid ? jidDecode(meLid) : { user: null };

        const meRecipients = [];
        const otherRecipients = [];

        for (const userResult of sessionDevices) {
            const { devices, id } = userResult;
            const dec = jidDecode(id);
            if (!dec) continue;
            const { user, server } = dec;
            const deviceList = devices?.deviceList;
            if (!Array.isArray(deviceList)) continue;

            for (const { id: device, keyIndex } of deviceList) {
                if (device !== 0 && !keyIndex) continue;

                const deviceJid = jidEncode(user, server, device);

                const isExactSenderDevice = deviceJid === meFullJid || (meLid && deviceJid === meLid);
                if (isExactSenderDevice) continue;

                const isMe = user === mePnUser || user === meLidUser;
                if (isMe) {
                    meRecipients.push(deviceJid);
                } else {
                    otherRecipients.push(deviceJid);
                }
            }
        }

        const allRecipients = [...otherRecipients, ...meRecipients];
        const uniqueJids = [...new Set(allRecipients)];

        logger?.debug?.({
            target: normalizedJid,
            meFullJid,
            meLid,
            otherRecipients,
            meRecipients,
            uniqueJids
        }, 'relay1to1 device enumeration');

        await assertSessions(uniqueJids, false);

        const dsmMessage = {
            deviceSentMessage: {
                destinationJid: normalizedJid,
                message
            }
        };
        const dsmEncoded = encodeWAMessage(dsmMessage);

        const extraAttrs = {};
        const mediaType = getMediaType(message);
        if (mediaType) {
            extraAttrs['mediatype'] = mediaType;
        }

        const [
            { nodes: otherNodes, shouldIncludeDeviceIdentity: s1 },
            { nodes: meNodes, shouldIncludeDeviceIdentity: s2 }
        ] = await Promise.all([
            createParticipantNodes(otherRecipients, encodedMsg, extraAttrs),
            createParticipantNodes(meRecipients, dsmEncoded, extraAttrs)
        ]);

        const allNodes = [...otherNodes, ...meNodes];
        const shouldIncludeDeviceIdentity = s1 || s2;

        const stanzaContent = [{
            tag: 'participants',
            attrs: {},
            content: allNodes
        }];

        if (shouldIncludeDeviceIdentity && creds.account) {
            stanzaContent.push({
                tag: 'device-identity',
                attrs: {},
                content: encodeSignedDeviceIdentity(creds.account, true)
            });
        }

        const stanza = {
            tag: 'message',
            attrs: {
                id: msgId,
                type: getMessageType(message),
                to: normalizedJid,
            },
            content: stanzaContent
        };

        if (options.cachedGroupMetadata) {
            stanza.attrs.device_fanout = 'false';
        }

        const contentType = getContentType(message);
        if (contentType === 'reactionMessage') {
            stanza.attrs.type = 'reaction';
        } else if (contentType === 'protocolMessage') {
            const protocolMsg = message.protocolMessage || message[contentType];
            if (protocolMsg?.type === 0) {
                stanza.attrs.type = 'revoke';
                stanza.attrs.edit = '7';
            } else if (protocolMsg?.type === 14) {
                stanza.attrs.type = 'text';
                stanza.attrs.edit = '1';
            }
        }

        await sendNode(stanza);

        return msgId;
    }

    async function fetchGroupParticipantJids(groupJid) {
        const cached = cacheLookup(groupParticipantsCache, groupJid, GROUP_PARTICIPANTS_TTL_MS);
        if (cached) return cached;

        const inflight = groupParticipantsInflight.get(groupJid);
        if (inflight) return inflight;

        const fetchPromise = (async () => {
            const result = await query({
                tag: 'iq',
                attrs: {
                    id: generateMessageTag(),
                    type: 'get',
                    xmlns: 'w:g2',
                    to: groupJid
                },
                content: [{ tag: 'query', attrs: { request: 'interactive' } }]
            });
            const groupNode = getBinaryNodeChild(result, 'group');
            if (!groupNode) return [];
            const participantNodes = getBinaryNodeChildren(groupNode, 'participant');
            const participants = participantNodes.map(p => p.attrs.jid).filter(Boolean);
            cacheWrite(groupParticipantsCache, groupJid, participants);
            return participants;
        })();
        groupParticipantsInflight.set(groupJid, fetchPromise);
        try {
            return await fetchPromise;
        } finally {
            groupParticipantsInflight.delete(groupJid);
        }
    }

    async function relayGroupMessage(groupJid, encodedMsg, message, msgId, meJid, options) {
        const meLid = creds.me?.lid;
        const meId = creds.me?.id;
        const groupSenderIdentity = meLid || meId;
        const senderIdentityNormalized = jidNormalizedUser(groupSenderIdentity);

        const { ciphertext, senderKeyDistributionMessage } = await signalRepository.encryptGroupMessage({
            group: groupJid,
            meId: senderIdentityNormalized,
            data: encodedMsg
        });

        const contentType = getContentType(message);
        let msgType = getMessageType(message);

        const mediaType = getMediaType(message);
        const encAttrs = { v: '2', type: 'skmsg' };
        if (mediaType) {
            encAttrs.mediatype = mediaType;
        }

        const stanza = {
            tag: 'message',
            attrs: {
                id: msgId,
                type: msgType,
                to: groupJid,
                addressing_mode: 'lid',
            },
            content: [{
                tag: 'enc',
                attrs: encAttrs,
                content: ciphertext
            }]
        };

        if (contentType === 'reactionMessage') {
            stanza.attrs.type = 'reaction';
        } else if (contentType === 'protocolMessage') {
            const protocolMsg = message.protocolMessage || message[contentType];
            if (protocolMsg?.type === 0) {
                stanza.attrs.type = 'revoke';
                stanza.attrs.edit = '7';
            } else if (protocolMsg?.type === 14) {
                stanza.attrs.type = 'text';
                stanza.attrs.edit = '1';
            }
        }

        let participantJids = options.participants;
        if (!participantJids) {
            logger?.debug?.({ groupJid }, 'auto-fetching group participants for SKDM');
            participantJids = await fetchGroupParticipantJids(groupJid);
        }

        if (participantJids && participantJids.length) {
            const devices = await getUSyncDevices(participantJids, true, false);
            const deviceJids = extractDeviceJids(devices, meJid, meLid, false);
            const allDeviceJids = deviceJids.map(d => jidEncode(d.user, d.server, d.device));

            if (allDeviceJids.length && senderKeyDistributionMessage) {
                await assertSessions(allDeviceJids, false);

                const senderKeyMsg = {
                    senderKeyDistributionMessage: {
                        axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage,
                        groupId: groupJid
                    }
                };
                const skdEncoded = encodeWAMessage(senderKeyMsg);
                const extraAttrs = {};
                if (mediaType) {
                    extraAttrs.mediatype = mediaType;
                }
                const { nodes: skdNodes, shouldIncludeDeviceIdentity } = await createParticipantNodes(allDeviceJids, skdEncoded, extraAttrs);

                stanza.content.push({
                    tag: 'participants',
                    attrs: {},
                    content: skdNodes
                });

                if (shouldIncludeDeviceIdentity) {
                    stanza.content.push({
                        tag: 'device-identity',
                        attrs: {},
                        content: encodeSignedDeviceIdentity(creds.account, true)
                    });
                }

                logger?.debug?.({ groupJid, skdCount: allDeviceJids.length }, 'SKDM sent to group participants');
            }
        }

        await sendNode(stanza);

        return msgId;
    }

    async function relayStatusBroadcast(jid, encodedMsg, message, msgId, meJid, options) {
        const statusJids = options.statusJidList || [];
        if (!statusJids.length) {
            throw new Error('Must provide statusJidList for status broadcast');
        }

        const allDeviceJids = [];
        for (const statusJid of statusJids) {
            const devices = await getUSyncDevices([statusJid], true, true);
            const deviceJids = extractDeviceJids(devices, meJid, creds.me?.lid, true);
            for (const d of deviceJids) {
                allDeviceJids.push(jidEncode(d.user, d.server, d.device));
            }
        }

        await assertSessions(allDeviceJids, false);
        const { nodes: participantNodes, shouldIncludeDeviceIdentity: needsDevId } = await createParticipantNodes(allDeviceJids, encodedMsg, {});

        const stanzaContent = [{
            tag: 'participants',
            attrs: {},
            content: participantNodes
        }];

        if (needsDevId && creds.account) {
            stanzaContent.push({
                tag: 'device-identity',
                attrs: {},
                content: encodeSignedDeviceIdentity(creds.account, true)
            });
        }

        const stanza = {
            tag: 'message',
            attrs: {
                id: msgId,
                type: 'text',
                to: jid,
            },
            content: stanzaContent
        };

        await sendNode(stanza);
        return msgId;
    }

    async function sendMessage(jid, content, options) {
        options = options || {};
        const { generateWAMessage } = require('./messages');
        const fullMsg = await generateWAMessage(jid, content, {
            ...options,
            userJid: creds.me?.id,
            upload: async (buffer, mediaType) => {
                const result = await encryptAndUploadMedia(buffer, mediaType);
                return result;
            }
        });

        const msgId = await relayMessage(jid, fullMsg.message, {
            messageId: fullMsg.key.id,
            ...options
        });

        fullMsg.key.id = msgId;
        fullMsg.status = 1;

        ev.emit('messages.upsert', {
            messages: [fullMsg],
            type: 'append'
        });

        return fullMsg;
    }

    async function encryptAndUploadMedia(buffer, mediaType) {
        const { promises: fsPromises } = require('fs');

        const encResult = await encryptedStream(buffer, mediaType, { logger });
        const fileEncSha256B64 = encResult.fileEncSha256.toString('base64');

        const urls = await waUploadToServer(encResult.encFilePath, {
            mediaType,
            fileEncSha256B64,
            timeoutMs: 60000
        });

        try {
            await fsPromises.unlink(encResult.encFilePath);
        } catch {}

        return {
            url: urls.mediaUrl,
            directPath: urls.directPath,
            mediaKey: encResult.mediaKey.toString('base64'),
            fileEncSha256: encResult.fileEncSha256,
            fileSha256: encResult.fileSha256,
            fileLength: encResult.fileLength,
        };
    }

    async function sendReceipt(jid, participant, messageIds, type) {
        const node = {
            tag: 'receipt',
            attrs: {
                id: messageIds[0],
            }
        };

        if (type) {
            node.attrs.type = type;
        }

        if (isJidGroup(jid)) {
            node.attrs.to = jid;
            if (participant) {
                node.attrs.participant = participant;
            }
        } else {
            node.attrs.to = jid;
            if (participant) {
                node.attrs.participant = participant;
            }
        }

        if (messageIds.length > 1) {
            node.content = messageIds.slice(1).map(id => ({
                tag: 'item',
                attrs: { id }
            }));
        }

        await sendNode(node);
    }

    async function sendReadReceipt(jid, participant, messageIds) {
        return sendReceipt(jid, participant, messageIds, 'read');
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
            await sendReadReceipt(group.jid, group.participant, group.ids);
        }
    }

    async function sendRetryRequest(node, forceIncludeKeys) {
        const msgId = node.attrs.id;
        const from = node.attrs.from;
        const participant = node.attrs.participant;
        const recipient = node.attrs.recipient;

        const retryCount = 1;

        const retryNode = {
            tag: 'receipt',
            attrs: {
                id: msgId,
                type: 'retry',
                to: from,
            },
            content: [{
                tag: 'retry',
                attrs: {
                    count: retryCount.toString(),
                    id: msgId,
                    t: node.attrs.t,
                    v: '1'
                }
            }]
        };

        if (participant) {
            retryNode.attrs.participant = participant;
        }

        if (forceIncludeKeys || retryCount >= 1) {
            retryNode.content.push({
                tag: 'registration',
                attrs: {},
                content: encodeBigEndian(creds.registrationId)
            });
        }

        await sendNode(retryNode);
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

    async function sendTyping(jid, isComposing) {
        const node = {
            tag: 'chatstate',
            attrs: { to: jid },
            content: [{
                tag: isComposing ? 'composing' : 'paused',
                attrs: {}
            }]
        };
        if (isJidGroup(jid)) {
            node.attrs.media = 'text';
        }
        await sendNode(node);
    }

    async function sendWAMBuffer(wamBuffer) {
        await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                xmlns: 'w:stats',
                type: 'set'
            },
            content: [{
                tag: 'add',
                attrs: {},
                content: wamBuffer
            }]
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

    async function fetchProfilePictureUrl(jid, type) {
        const result = await query({
            tag: 'iq',
            attrs: {
                to: jid,
                type: 'get',
                xmlns: 'w:profile:picture'
            },
            content: [{
                tag: 'picture',
                attrs: { type: type || 'preview', query: 'url' }
            }]
        });
        const pictureNode = getBinaryNodeChild(result, 'picture');
        return pictureNode?.attrs?.url;
    }

    async function updateProfilePicture(jid, content) {
        let img;
        if (Buffer.isBuffer(content)) {
            img = content;
        } else if (typeof content === 'object' && content.img) {
            img = content.img;
        }
        await query({
            tag: 'iq',
            attrs: {
                to: jid,
                type: 'set',
                xmlns: 'w:profile:picture'
            },
            content: [{
                tag: 'picture',
                attrs: { type: 'image' },
                content: img
            }]
        });
    }

    async function removeProfilePicture(jid) {
        await query({
            tag: 'iq',
            attrs: {
                to: jid,
                type: 'set',
                xmlns: 'w:profile:picture'
            },
            content: [{
                tag: 'picture',
                attrs: { type: 'image' }
            }]
        });
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

    async function updateProfileStatus(status) {
        await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                xmlns: 'status',
                type: 'set'
            },
            content: [{
                tag: 'status',
                attrs: {},
                content: Buffer.from(status, 'utf-8')
            }]
        });
    }

    async function onlineOnReconnect() {
        await sendPresenceUpdate('available');
    }

    async function uploadPreKeysToServerIfRequired() {
        try {
            const result = await query({
                tag: 'iq',
                attrs: {
                    xmlns: 'encrypt',
                    type: 'get',
                    to: S_WHATSAPP_NET
                },
                content: [{ tag: 'count', attrs: {} }]
            });
            const countChild = getBinaryNodeChild(result, 'count');
            const preKeyCount = +(countChild?.attrs?.value || 0);
            if (preKeyCount < MIN_PREKEY_COUNT) {
                const { update, node } = await getNextPreKeysNode({ creds, keys }, INITIAL_PREKEY_COUNT);
                await query(node);
                ev.emit('creds.update', update);
            }
        } catch (err) {
            logger.error?.({ err }, 'Failed to upload pre-keys');
        }
    }

    async function sendReceipts(keys, type) {
        const grouped = aggregateMessageKeysNotFromMe(keys);
        for (const { jid, participant, messageIds } of grouped) {
            await sendReceipt(jid, participant, messageIds, type);
        }
    }

    async function getPrivacyTokens(jids) {
        const now = unixTimestampSeconds().toString();
        const tokenNodes = jids.map(jid => ({
            tag: 'token',
            attrs: {
                jid: jidNormalizedUser(jid),
                t: now,
                type: 'trusted_contact'
            }
        }));
        return query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'privacy'
            },
            content: [{
                tag: 'tokens',
                attrs: {},
                content: tokenNodes
            }]
        });
    }

    async function sendPeerDataOperationMessage(pdoMessage) {
        if (!authState.creds.me?.id) {
            throw new Error('Not authenticated — cannot send peer data operation');
        }
        const payload = {
            protocolMessage: {
                peerDataOperationRequestMessage: pdoMessage,
                type: 5
            }
        };
        const selfJid = jidNormalizedUser(authState.creds.me.id);
        return relayMessage(selfJid, payload, {
            additionalAttributes: {
                category: 'peer',
                push_priority: 'high_force'
            },
            additionalNodes: [{
                tag: 'meta',
                attrs: { appdata: 'default' }
            }]
        });
    }

    async function fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestamp) {
        const historyRequest = {
            historySyncOnDemandRequest: {
                chatJid: oldestMsgKey.remoteJid,
                oldestMsgFromMe: oldestMsgKey.fromMe,
                oldestMsgId: oldestMsgKey.id,
                oldestMsgTimestampMs: oldestMsgTimestamp,
                onDemandMsgCount: count
            },
            peerDataOperationRequestType: 1
        };
        return sendPeerDataOperationMessage(historyRequest);
    }

    const _pendingResends = new Map();

    ev.on('messages.upsert', ({ messages }) => {
        for (const msg of messages) {
            if (msg.key?.id && _pendingResends.has(msg.key.id)) {
                _pendingResends.delete(msg.key.id);
            }
        }
    });

    async function requestPlaceholderResend(messageKey) {
        if (!authState.creds.me?.id) {
            throw new Error('Not authenticated — cannot request resend');
        }
        const msgId = messageKey?.id;
        if (_pendingResends.has(msgId)) {
            logger?.debug?.({ messageKey }, 'resend already requested for this message');
            return;
        }
        _pendingResends.set(msgId, Date.now());
        await new Promise(r => setTimeout(r, 5000));
        if (!_pendingResends.has(msgId)) {
            logger?.debug?.({ messageKey }, 'message arrived while waiting — no resend needed');
            return 'RESOLVED';
        }
        const resendRequest = {
            placeholderMessageResendRequest: [{ messageKey }],
            peerDataOperationRequestType: 2
        };
        setTimeout(() => {
            if (_pendingResends.has(msgId)) {
                logger?.debug?.({ messageKey }, 'resend timed out after 15s — phone may be offline');
                _pendingResends.delete(msgId);
            }
        }, 15000);
        return sendPeerDataOperationMessage(resendRequest);
    }

    const mediaUpdateWaiter = bindWaitForEvent(ev, 'messages.media-update');

    async function updateMediaMessage(message) {
        const mediaContent = assertMediaContent(message.message);
        const currentMediaKey = mediaContent.mediaKey;
        const myId = authState.creds.me?.id;
        if (!myId) {
            throw new Error('Not authenticated — cannot update media');
        }
        const retryNode = await encryptMediaRetryRequest(message.key, currentMediaKey, myId);
        let updateError;
        await Promise.all([
            sendNode(retryNode),
            mediaUpdateWaiter(async (updates) => {
                const match = updates.find(u => u.key.id === message.key.id);
                if (!match) return false;
                if (match.error) {
                    updateError = match.error;
                } else {
                    try {
                        const decrypted = await decryptMediaRetryData(match.media, currentMediaKey, match.key.id);
                        if (decrypted.result !== 0) {
                            throw new Error('Media re-upload was unsuccessful (result=' + decrypted.result + ')');
                        }
                        mediaContent.directPath = decrypted.directPath;
                        mediaContent.url = getUrlFromDirectPath(decrypted.directPath);
                        logger?.debug?.({ directPath: decrypted.directPath, key: match.key }, 'media re-upload succeeded');
                    } catch (err) {
                        updateError = err;
                    }
                }
                return true;
            })
        ]);
        if (updateError) throw updateError;
        ev.emit('messages.update', [{
            key: message.key,
            update: { message: message.message }
        }]);
        return message;
    }

    return {
        sendMessage,
        relayMessage,
        sendReceipt,
        sendReadReceipt,
        readMessages,
        sendRetryRequest,
        sendPresenceUpdate,
        presenceSubscribe,
        sendTyping,
        sendWAMBuffer,
        fetchBlocklist,
        updateBlockStatus,
        fetchStatus,
        fetchProfilePictureUrl,
        updateProfilePicture,
        removeProfilePicture,
        updateProfileName,
        updateProfileStatus,
        onlineOnReconnect,
        uploadPreKeysToServerIfRequired,
        refreshMediaConn,
        waUploadToServer,
        relayMessage,
        assertSessions,
        getUSyncDevices,
        createParticipantNodes,
        encodeWAMessage,
        encryptAndUploadMedia,
        sendReceipts,
        getPrivacyTokens,
        sendPeerDataOperationMessage,
        updateMediaMessage,
        fetchMessageHistory,
        requestPlaceholderResend,
    };
}

module.exports = {
    makeMessagesSocket,
    createSignalIdentity,
    generateOrGetPreKeys,
    getNextPreKeys,
    getNextPreKeysNode,
    xmppSignedPreKey,
    xmppPreKey,
    parseAndInjectE2ESessions,
    extractDeviceJids,
    encodeSignedDeviceIdentity,
    generateMessageIDV2,
};
