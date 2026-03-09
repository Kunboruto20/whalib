'use strict';

const path = require('path');
const {
    jidDecode,
    jidEncode,
    jidNormalizedUser,
    isJidGroup,
    isJidStatusBroadcast,
    isJidBroadcast,
    isLidUser,
    isPnUser,
    areJidsSameUser
} = require('./jid-utils');
const { getContentType, normalizeMessageContent, extractMessageContent } = require('./messages');
const { aesDecryptGCM, hmacSign } = require('./crypto-utils');
const { toNumber, getKeyAuthor } = require('./generics');
const { downloadAndProcessHistorySyncNotification } = require('./history');

let _proto = null;
function loadProto() {
    if (_proto) return _proto;
    const protobuf = require('protobufjs');
    const root = protobuf.loadSync(path.join(__dirname, '..', 'proto', 'whatsapp.proto'));
    _proto = {
        Message: root.lookupType('proto.Message'),
        WebMessageInfo: root.lookupType('proto.WebMessageInfo'),
    };
    try {
        _proto.LIDMigrationMappingSyncPayload = root.lookupType('proto.LIDMigrationMappingSyncPayload');
    } catch {}
    try {
        _proto.EventResponseMessage = root.lookupType('proto.Message.EventResponseMessage');
    } catch {}
    try {
        _proto.PollVoteMessage = root.lookupType('proto.Message.PollVoteMessage');
    } catch {}
    return _proto;
}

const REAL_MSG_STUB_TYPES = new Set([
    'CALL_MISSED_GROUP_VIDEO',
    'CALL_MISSED_GROUP_VOICE',
    'CALL_MISSED_VIDEO',
    'CALL_MISSED_VOICE'
]);

const REAL_MSG_REQ_ME_STUB_TYPES = new Set(['GROUP_PARTICIPANT_ADD']);

function isHostedPnUser(jid) {
    if (!jid) return false;
    const decoded = jidDecode(jid);
    if (!decoded) return false;
    return decoded.server === 's.whatsapp.net' && decoded.device !== undefined && decoded.device > 0;
}

function isHostedLidUser(jid) {
    if (!jid) return false;
    const decoded = jidDecode(jid);
    if (!decoded) return false;
    return decoded.server === 'lid' && decoded.device !== undefined && decoded.device > 0;
}

function cleanMessage(message, meId, meLid) {
    if (message.key?.remoteJid) {
        if (isHostedPnUser(message.key.remoteJid)) {
            const decoded = jidDecode(message.key.remoteJid);
            message.key.remoteJid = jidEncode(decoded?.user, 's.whatsapp.net');
        } else if (isHostedLidUser(message.key.remoteJid)) {
            const decoded = jidDecode(message.key.remoteJid);
            message.key.remoteJid = jidEncode(decoded?.user, 'lid');
        } else {
            message.key.remoteJid = jidNormalizedUser(message.key.remoteJid);
        }
    }

    if (message.key?.participant) {
        if (isHostedPnUser(message.key.participant)) {
            const decoded = jidDecode(message.key.participant);
            message.key.participant = jidEncode(decoded?.user, 's.whatsapp.net');
        } else if (isHostedLidUser(message.key.participant)) {
            const decoded = jidDecode(message.key.participant);
            message.key.participant = jidEncode(decoded?.user, 'lid');
        } else {
            message.key.participant = jidNormalizedUser(message.key.participant);
        }
    }

    const content = normalizeMessageContent(message.message);

    if (content?.reactionMessage) {
        normaliseKey(content.reactionMessage.key);
    }
    if (content?.pollUpdateMessage) {
        normaliseKey(content.pollUpdateMessage.pollCreationMessageKey);
    }

    function normaliseKey(msgKey) {
        if (!msgKey) return;
        if (!message.key.fromMe) {
            msgKey.fromMe = !msgKey.fromMe
                ? areJidsSameUser(msgKey.participant || msgKey.remoteJid, meId) ||
                  (meLid ? areJidsSameUser(msgKey.participant || msgKey.remoteJid, meLid) : false)
                : false;
            msgKey.remoteJid = message.key.remoteJid;
            msgKey.participant = msgKey.participant || message.key.participant;
        }
    }
}

function isRealMessage(message) {
    const normalizedContent = normalizeMessageContent(message.message);
    const hasSomeContent = !!getContentType(normalizedContent);
    return (
        (!!normalizedContent ||
            REAL_MSG_STUB_TYPES.has(message.messageStubType) ||
            REAL_MSG_REQ_ME_STUB_TYPES.has(message.messageStubType)) &&
        hasSomeContent &&
        !normalizedContent?.protocolMessage &&
        !normalizedContent?.reactionMessage &&
        !normalizedContent?.pollUpdateMessage
    );
}

function shouldIncrementChatUnread(message) {
    return !message.key.fromMe && !message.messageStubType;
}

function getChatId({ remoteJid, participant, fromMe }) {
    if (isJidBroadcast(remoteJid) && !isJidStatusBroadcast(remoteJid) && !fromMe) {
        return participant;
    }
    return remoteJid;
}

function decryptPollVote({ encPayload, encIv }, { pollCreatorJid, pollMsgId, pollEncKey, voterJid }) {
    const toBinary = (txt) => Buffer.from(txt);
    const sign = Buffer.concat([
        toBinary(pollMsgId),
        toBinary(pollCreatorJid),
        toBinary(voterJid),
        toBinary('Poll Vote'),
        new Uint8Array([1])
    ]);
    const key0 = hmacSign(pollEncKey, new Uint8Array(32), 'sha256');
    const decKey = hmacSign(sign, key0, 'sha256');
    const aad = toBinary(`${pollMsgId}\u0000${voterJid}`);
    const decrypted = aesDecryptGCM(encPayload, decKey, encIv, aad);
    const proto = loadProto();
    if (proto.PollVoteMessage) {
        return proto.PollVoteMessage.decode(decrypted);
    }
    return { selectedOptions: [] };
}

function decryptEventResponse({ encPayload, encIv }, { eventCreatorJid, eventMsgId, eventEncKey, responderJid }) {
    const toBinary = (txt) => Buffer.from(txt);
    const sign = Buffer.concat([
        toBinary(eventMsgId),
        toBinary(eventCreatorJid),
        toBinary(responderJid),
        toBinary('Event Response'),
        new Uint8Array([1])
    ]);
    const key0 = hmacSign(eventEncKey, new Uint8Array(32), 'sha256');
    const decKey = hmacSign(sign, key0, 'sha256');
    const aad = toBinary(`${eventMsgId}\u0000${responderJid}`);
    const decrypted = aesDecryptGCM(encPayload, decKey, encIv, aad);
    const proto = loadProto();
    if (proto.EventResponseMessage) {
        return proto.EventResponseMessage.decode(decrypted);
    }
    return {};
}

async function processMessage(message, ctx) {
    const {
        shouldProcessHistoryMsg,
        placeholderResendCache,
        ev,
        creds,
        signalRepository,
        keyStore,
        keys,
        logger,
        options,
        getMessage
    } = ctx;

    const meId = creds.me?.id;
    const meLid = creds.me?.lid;
    const { accountSettings } = creds;

    const chat = { id: jidNormalizedUser(getChatId(message.key)) };
    const realMsg = isRealMessage(message);

    if (realMsg) {
        chat.messages = [{ message }];
        chat.conversationTimestamp = toNumber(message.messageTimestamp) || Math.floor(Date.now() / 1000);
        if (shouldIncrementChatUnread(message)) {
            chat.unreadCount = (chat.unreadCount || 0) + 1;
        }
    }

    const content = normalizeMessageContent(message.message);

    if ((realMsg || content?.reactionMessage?.key?.fromMe) && accountSettings?.unarchiveChats) {
        chat.archived = false;
        chat.readOnly = false;
    }

    const protocolMsg = content?.protocolMessage;
    if (protocolMsg) {
        const type = protocolMsg.type;
        switch (type) {
            case 0:
                ev.emit('messages.update', [{
                    key: {
                        ...message.key,
                        id: protocolMsg.key?.id
                    },
                    update: {
                        message: null,
                        messageStubType: 'REVOKE',
                        key: message.key
                    }
                }]);
                break;

            case 3: {
                const histNotification = protocolMsg.historySyncNotification;
                if (histNotification) {
                    const process = shouldProcessHistoryMsg !== false;
                    const isLatest = !creds.processedHistoryMessages?.length;

                    if (logger) {
                        logger.info?.({
                            histNotification,
                            process,
                            id: message.key.id,
                            isLatest
                        }, 'got history notification');
                    }

                    if (process) {
                        const ON_DEMAND_SYNC_TYPE = 6;
                        if (histNotification.syncType !== ON_DEMAND_SYNC_TYPE) {
                            ev.emit('creds.update', {
                                processedHistoryMessages: [
                                    ...(creds.processedHistoryMessages || []),
                                    { key: message.key, messageTimestamp: message.messageTimestamp }
                                ]
                            });
                        }

                        const data = await downloadAndProcessHistorySyncNotification(histNotification, options);
                        ev.emit('messaging-history.set', {
                            ...data,
                            isLatest: histNotification.syncType !== ON_DEMAND_SYNC_TYPE ? isLatest : undefined,
                            peerDataRequestSessionId: histNotification.peerDataRequestSessionId
                        });
                    }
                }
                break;
            }

            case 6:
                Object.assign(chat, {
                    ephemeralSettingTimestamp: toNumber(message.messageTimestamp) || 0,
                    ephemeralExpiration: protocolMsg.ephemeralExpiration || null
                });
                break;

            case 14:
                ev.emit('messages.update', [{
                    key: { ...message.key, id: protocolMsg.key?.id },
                    update: {
                        message: {
                            editedMessage: {
                                message: protocolMsg.editedMessage
                            }
                        },
                        messageTimestamp: protocolMsg.timestampMs
                            ? Math.floor(toNumber(protocolMsg.timestampMs) / 1000)
                            : message.messageTimestamp
                    }
                }]);
                break;

            case 15: {
                const appStateKeys = protocolMsg.appStateSyncKeyShare?.keys;
                const store = keyStore || keys;
                if (appStateKeys?.length && store) {
                    let newAppStateSyncKeyId = '';
                    const newKeys = [];
                    const setKeys = async () => {
                        for (const { keyData, keyId } of appStateKeys) {
                            const strKeyId = Buffer.from(keyId.keyId).toString('base64');
                            newKeys.push(strKeyId);
                            await store.set({ 'app-state-sync-key': { [strKeyId]: keyData } });
                            newAppStateSyncKeyId = strKeyId;
                        }
                    };

                    if (store.transaction) {
                        await store.transaction(setKeys, meId);
                    } else {
                        await setKeys();
                    }

                    if (logger) logger.info?.({ newAppStateSyncKeyId, newKeys }, 'injecting new app state sync keys');
                    ev.emit('creds.update', { myAppStateKeyId: newAppStateSyncKeyId });
                } else {
                    if (logger) logger.info?.({ protocolMsg }, 'recv app state sync with 0 keys');
                }
                break;
            }

            case 17: {
                const response = protocolMsg.peerDataOperationRequestResponseMessage;
                if (response) {
                    if (placeholderResendCache) {
                        await placeholderResendCache.del?.(response.stanzaId);
                    }

                    const { peerDataOperationResult } = response;
                    if (peerDataOperationResult) {
                        for (const result of peerDataOperationResult) {
                            if (result.placeholderMessageResendResponse) {
                                const proto = loadProto();
                                const webMsgInfo = proto.WebMessageInfo.decode(
                                    result.placeholderMessageResendResponse.webMessageInfoBytes
                                );
                                setTimeout(() => {
                                    ev.emit('messages.upsert', {
                                        messages: [webMsgInfo],
                                        type: 'notify',
                                        requestId: response.stanzaId
                                    });
                                }, 500);
                            }
                        }
                    }
                }
                break;
            }

            case 32: {
                const proto = loadProto();
                if (proto.LIDMigrationMappingSyncPayload) {
                    const encodedPayload = protocolMsg.lidMigrationMappingSyncMessage?.encodedMappingPayload;
                    if (encodedPayload) {
                        try {
                            const { pnToLidMappings, chatDbMigrationTimestamp } = proto.LIDMigrationMappingSyncPayload.decode(encodedPayload);
                            if (logger) logger.debug?.({ pnToLidMappings, chatDbMigrationTimestamp }, 'got lid mappings and chat db migration timestamp');

                            const pairs = [];
                            if (pnToLidMappings) {
                                for (const { pn, latestLid, assignedLid } of pnToLidMappings) {
                                    const lid = latestLid || assignedLid;
                                    pairs.push({ lid: `${lid}@lid`, pn: `${pn}@s.whatsapp.net` });
                                }
                            }

                            if (signalRepository?.lidMapping) {
                                await signalRepository.lidMapping.storeLIDPNMappings(pairs);
                                if (pairs.length && signalRepository.migrateSession) {
                                    for (const { pn, lid } of pairs) {
                                        await signalRepository.migrateSession(pn, lid);
                                    }
                                }
                            }
                        } catch (err) {
                            if (logger) logger.error?.({ err }, 'failed to process LID migration mapping');
                        }
                    }
                }
                break;
            }
        }
    } else if (content?.reactionMessage) {
        const reaction = {
            ...content.reactionMessage,
            key: message.key
        };
        ev.emit('messages.reaction', [{
            reaction,
            key: content.reactionMessage?.key
        }]);
    } else if (content?.encEventResponseMessage) {
        const encEventResponse = content.encEventResponseMessage;
        const creationMsgKey = encEventResponse.eventCreationMessageKey;
        if (creationMsgKey && getMessage) {
            const eventMsg = await getMessage(creationMsgKey);
            if (eventMsg) {
                try {
                    const meIdNormalised = jidNormalizedUser(meId);
                    const eventCreatorKey = creationMsgKey.participant || creationMsgKey.remoteJid;
                    let eventCreatorPn = eventCreatorKey;
                    if (isLidUser(eventCreatorKey) && signalRepository?.lidMapping) {
                        const pn = await signalRepository.lidMapping.getPNForLID(eventCreatorKey);
                        if (pn) eventCreatorPn = pn;
                    }
                    const eventCreatorJid = getKeyAuthor(
                        { remoteJid: jidNormalizedUser(eventCreatorPn), fromMe: meIdNormalised === eventCreatorPn },
                        meIdNormalised
                    );
                    const responderJid = getKeyAuthor(message.key, meIdNormalised);
                    const eventEncKey = eventMsg?.messageContextInfo?.messageSecret;

                    if (!eventEncKey) {
                        if (logger) logger.warn?.({ creationMsgKey }, 'event response: missing messageSecret for decryption');
                    } else {
                        const responseMsg = decryptEventResponse(encEventResponse, {
                            eventEncKey,
                            eventCreatorJid,
                            eventMsgId: creationMsgKey.id,
                            responderJid
                        });
                        const eventResponse = {
                            eventResponseMessageKey: message.key,
                            senderTimestampMs: responseMsg.timestampMs,
                            response: responseMsg
                        };
                        ev.emit('messages.update', [{
                            key: creationMsgKey,
                            update: {
                                eventResponses: [eventResponse]
                            }
                        }]);
                    }
                } catch (err) {
                    if (logger) logger.warn?.({ err, creationMsgKey }, 'failed to decrypt event response');
                }
            } else {
                if (logger) logger.warn?.({ creationMsgKey }, 'event creation message not found, cannot decrypt response');
            }
        }
    } else if (content?.pollUpdateMessage) {
        const pollUpdateMsg = content.pollUpdateMessage;
        const creationMsgKey = pollUpdateMsg.pollCreationMessageKey;
        if (creationMsgKey && getMessage) {
            const pollMsg = await getMessage(creationMsgKey);
            if (pollMsg) {
                try {
                    const meIdNormalised = jidNormalizedUser(meId);
                    const pollCreatorJid = getKeyAuthor(creationMsgKey, meIdNormalised);
                    const voterJid = getKeyAuthor(message.key, meIdNormalised);
                    const pollEncKey = pollMsg.messageContextInfo?.messageSecret;

                    if (pollEncKey) {
                        const voteMsg = decryptPollVote(
                            pollUpdateMsg.vote,
                            {
                                pollEncKey,
                                pollCreatorJid,
                                pollMsgId: creationMsgKey.id,
                                voterJid
                            }
                        );
                        ev.emit('messages.update', [{
                            key: creationMsgKey,
                            update: {
                                pollUpdates: [{
                                    pollUpdateMessageKey: message.key,
                                    vote: voteMsg,
                                    senderTimestampMs: toNumber(pollUpdateMsg.senderTimestampMs || 0)
                                }]
                            }
                        }]);
                    }
                } catch (err) {
                    if (logger) logger.warn?.({ err, creationMsgKey }, 'failed to decrypt poll vote');
                }
            } else {
                if (logger) logger.warn?.({ creationMsgKey }, 'poll creation message not found, cannot decrypt update');
            }
        }
    } else if (message.messageStubType) {
        handleMessageStub(message, chat, ev, meId);
    }

    if (Object.keys(chat).length > 1) {
        ev.emit('chats.update', [chat]);
    }
}

function handleMessageStub(message, chat, ev, meId) {
    const jid = message.key?.remoteJid;
    let participants;

    const emitParticipantsUpdate = (action) => ev.emit('group-participants.update', {
        id: jid,
        author: message.key.participant,
        authorPn: message.key.participantAlt,
        participants,
        action
    });

    const emitGroupUpdate = (update) => {
        ev.emit('groups.update', [{
            id: jid,
            ...update,
            author: message.key.participant ?? undefined,
            authorPn: message.key.participantAlt
        }]);
    };

    const emitGroupRequestJoin = (participant, action, method) => {
        ev.emit('group.join-request', {
            id: jid,
            author: message.key.participant,
            authorPn: message.key.participantAlt,
            participant: participant.lid || participant,
            participantPn: participant.pn || participant,
            action,
            method
        });
    };

    const participantsIncludesMe = () => {
        if (!participants) return false;
        return participants.some(p => {
            const pJid = typeof p === 'object' ? (p.phoneNumber || p.jid || p.pn || p) : p;
            return areJidsSameUser(meId, pJid);
        });
    };

    const parseParticipants = (params) => {
        if (!params?.length) return [];
        return params.map(a => {
            try {
                return JSON.parse(a);
            } catch {
                return a;
            }
        });
    };

    const stubType = message.messageStubType;
    const stubParams = message.messageStubParameters || [];

    switch (stubType) {
        case 'GROUP_PARTICIPANT_CHANGE_NUMBER':
            participants = parseParticipants(stubParams);
            emitParticipantsUpdate('modify');
            break;
        case 'GROUP_PARTICIPANT_LEAVE':
        case 'GROUP_PARTICIPANT_REMOVE':
            participants = parseParticipants(stubParams);
            emitParticipantsUpdate('remove');
            if (participantsIncludesMe()) {
                chat.readOnly = true;
            }
            break;
        case 'GROUP_PARTICIPANT_ADD':
        case 'GROUP_PARTICIPANT_INVITE':
        case 'GROUP_PARTICIPANT_ADD_REQUEST_JOIN':
            participants = parseParticipants(stubParams);
            if (participantsIncludesMe()) {
                chat.readOnly = false;
            }
            emitParticipantsUpdate('add');
            break;
        case 'GROUP_PARTICIPANT_DEMOTE':
            participants = parseParticipants(stubParams);
            emitParticipantsUpdate('demote');
            break;
        case 'GROUP_PARTICIPANT_PROMOTE':
            participants = parseParticipants(stubParams);
            emitParticipantsUpdate('promote');
            break;
        case 'GROUP_CHANGE_ANNOUNCE':
            emitGroupUpdate({ announce: stubParams[0] === 'true' || stubParams[0] === 'on' });
            break;
        case 'GROUP_CHANGE_RESTRICT':
            emitGroupUpdate({ restrict: stubParams[0] === 'true' || stubParams[0] === 'on' });
            break;
        case 'GROUP_CHANGE_SUBJECT':
            chat.name = stubParams[0];
            emitGroupUpdate({ subject: stubParams[0] });
            break;
        case 'GROUP_CHANGE_DESCRIPTION':
            chat.description = stubParams[0];
            emitGroupUpdate({ desc: stubParams[0] });
            break;
        case 'GROUP_CHANGE_INVITE_LINK':
            emitGroupUpdate({ inviteCode: stubParams[0] });
            break;
        case 'GROUP_MEMBER_ADD_MODE':
            emitGroupUpdate({ memberAddMode: stubParams[0] === 'all_member_add' });
            break;
        case 'GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE':
            emitGroupUpdate({ joinApprovalMode: stubParams[0] === 'on' });
            break;
        case 'GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD': {
            let participant;
            try {
                participant = JSON.parse(stubParams[0]);
            } catch {
                participant = stubParams[0];
            }
            const action = stubParams[1];
            const method = stubParams[2];
            emitGroupRequestJoin(participant, action, method);
            break;
        }
    }
}

module.exports = {
    cleanMessage,
    isRealMessage,
    shouldIncrementChatUnread,
    getChatId,
    decryptPollVote,
    decryptEventResponse,
    processMessage,
    handleMessageStub,
    isHostedPnUser,
    isHostedLidUser,
};
