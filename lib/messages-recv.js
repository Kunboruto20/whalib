'use strict';

const path = require('path');
const {
    getBinaryNodeChild,
    getBinaryNodeChildren,
    getBinaryNodeChildBuffer,
    getAllBinaryNodeChildren,
    assertNodeErrorFree
} = require('./binary-node');
const {
    jidDecode,
    jidEncode,
    jidNormalizedUser,
    isJidGroup,
    isJidStatusBroadcast,
    isJidBroadcast,
    isJidNewsletter,
    isLidUser,
    isPnUser,
    areJidsSameUser,
    S_WHATSAPP_NET
} = require('./jid-utils');
const { unpadRandomMax16, hmacSign, aesDecryptGCM } = require('./crypto-utils');
const { getContentType, extractMessageContent, normalizeMessageContent, loadProto } = require('./messages');

const NO_MESSAGE_FOUND_ERROR_TEXT = 'Message absent from node';
const MISSING_KEYS_ERROR_TEXT = 'Key used already or never filled';

const DECRYPTION_RETRY_CONFIG = {
    maxRetries: 3,
    baseDelayMs: 100,
    sessionRecordErrors: ['No session record', 'SessionError: No session record']
};

const NACK_REASONS = {
    ParsingError: 487,
    UnrecognizedStanza: 488,
    UnrecognizedStanzaClass: 489,
    UnrecognizedStanzaType: 490,
    InvalidProtobuf: 491,
    InvalidHostedCompanionStanza: 493,
    MissingMessageSecret: 495,
    SignalErrorOldCounter: 496,
    MessageDeletedOnPeer: 499,
    UnhandledError: 500,
    UnsupportedAdminRevoke: 550,
    UnsupportedLIDGroup: 551,
    DBOperationFailed: 552
};

const REAL_MSG_STUB_TYPES = new Set([
    'CALL_MISSED_GROUP_VIDEO',
    'CALL_MISSED_GROUP_VOICE',
    'CALL_MISSED_VIDEO',
    'CALL_MISSED_VOICE'
]);

const REAL_MSG_REQ_ME_STUB_TYPES = new Set(['GROUP_PARTICIPANT_ADD']);

const RECEIPT_STATUS_MAP = {
    'sender': 2,
    'played': 5,
    'read': 4,
    'read-self': 4
};

const MSG_STATUS = {
    ERROR: 0,
    PENDING: 1,
    SERVER_ACK: 2,
    DELIVERY_ACK: 3,
    READ: 4,
    PLAYED: 5
};

function getStatusFromReceiptType(type) {
    if (typeof type === 'undefined') {
        return MSG_STATUS.DELIVERY_ACK;
    }
    return RECEIPT_STATUS_MAP[type];
}

function deriveCallStatus(childNode) {
    if (!childNode) return 'ringing';
    const { tag, attrs } = childNode;
    switch (tag) {
        case 'offer':
        case 'offer_notice':
            return 'offer';
        case 'terminate':
            return (attrs && attrs.reason === 'timeout') ? 'timeout' : 'terminate';
        case 'reject':
            return 'reject';
        case 'accept':
            return 'accept';
        default:
            return 'ringing';
    }
}

function extractHistorySyncMsg(message) {
    if (!message) return undefined;
    const normalized = normalizeMessageContent(message);
    return normalized?.protocolMessage?.historySyncNotification;
}

function getBinaryNodeChildString(node, tag) {
    const child = getBinaryNodeChild(node, tag);
    if (!child) return undefined;
    if (typeof child.content === 'string') return child.content;
    if (Buffer.isBuffer(child.content)) return child.content.toString('utf-8');
    if (child.content instanceof Uint8Array) return Buffer.from(child.content).toString('utf-8');
    return child.content?.toString?.() || undefined;
}

function isJidBroadcastFn(jid) {
    if (!jid) return false;
    return jid.endsWith('@broadcast');
}

function extractAddressingContext(stanza) {
    let senderAlt;
    let recipientAlt;
    const sender = stanza.attrs.participant || stanza.attrs.from;
    const addressingMode = stanza.attrs.addressing_mode || (sender?.endsWith('lid') ? 'lid' : 'pn');

    if (addressingMode === 'lid') {
        senderAlt = stanza.attrs.participant_pn || stanza.attrs.sender_pn || stanza.attrs.peer_recipient_pn;
        recipientAlt = stanza.attrs.recipient_pn;
    } else {
        senderAlt = stanza.attrs.participant_lid || stanza.attrs.sender_lid || stanza.attrs.peer_recipient_lid;
        recipientAlt = stanza.attrs.recipient_lid;
    }

    return {
        addressingMode,
        senderAlt,
        recipientAlt
    };
}

function decodeMessageNode(stanza, meId, meLid) {
    let msgType;
    let chatId;
    let author;
    let fromMe = false;
    const msgId = stanza.attrs.id;
    const from = stanza.attrs.from;
    const participant = stanza.attrs.participant;
    const recipient = stanza.attrs.recipient;
    const addressingContext = extractAddressingContext(stanza);

    const isMe = (jid) => areJidsSameUser(jid, meId);
    const isMeLid = (jid) => meLid ? areJidsSameUser(jid, meLid) : false;

    if (isPnUser(from) || isLidUser(from)) {
        if (recipient) {
            if (isMe(from) || isMeLid(from)) {
                fromMe = true;
            }
            chatId = recipient;
        } else {
            chatId = from;
        }
        msgType = 'chat';
        author = from;
    } else if (isJidGroup(from)) {
        if (!participant) {
            throw new Error('No participant in group message');
        }
        if (isMe(participant) || isMeLid(participant)) {
            fromMe = true;
        }
        msgType = 'group';
        author = participant;
        chatId = from;
    } else if (isJidBroadcastFn(from)) {
        if (!participant) {
            throw new Error('No participant in broadcast message');
        }
        const isParticipantMe = isMe(participant);
        if (isJidStatusBroadcast(from)) {
            msgType = isParticipantMe ? 'direct_peer_status' : 'other_status';
        } else {
            msgType = isParticipantMe ? 'peer_broadcast' : 'other_broadcast';
        }
        fromMe = isParticipantMe;
        chatId = from;
        author = participant;
    } else if (isJidNewsletter(from)) {
        msgType = 'newsletter';
        chatId = from;
        author = from;
        if (isMe(from) || isMeLid(from)) {
            fromMe = true;
        }
    } else {
        throw new Error('Unknown message type for ' + from);
    }

    const pushname = stanza?.attrs?.notify;
    const key = {
        remoteJid: chatId,
        remoteJidAlt: !isJidGroup(chatId) ? addressingContext.senderAlt : undefined,
        fromMe,
        id: msgId,
        participant,
        participantAlt: isJidGroup(chatId) ? addressingContext.senderAlt : undefined,
        addressingMode: addressingContext.addressingMode,
        ...(msgType === 'newsletter' && stanza.attrs.server_id ? { server_id: stanza.attrs.server_id } : {})
    };

    const proto = loadProto();
    const fullMessage = {
        key,
        category: stanza.attrs.category,
        messageTimestamp: +(stanza.attrs.t || Math.floor(Date.now() / 1000)),
        pushName: pushname,
        broadcast: isJidBroadcastFn(from)
    };

    if (key.fromMe) {
        fullMessage.status = 2;
    }

    return {
        fullMessage,
        author,
        sender: msgType === 'chat' ? author : chatId
    };
}

function decryptMessageNode(stanza, meId, meLid, repository, logger) {
    const { fullMessage, author, sender } = decodeMessageNode(stanza, meId, meLid);

    return {
        fullMessage,
        category: stanza.attrs.category,
        author,
        async decrypt() {
            let decryptables = 0;
            const proto = loadProto();

            if (Array.isArray(stanza.content)) {
                for (const child of stanza.content) {
                    const { tag, attrs, content } = child;

                    if (tag === 'verified_name' && content instanceof Uint8Array) {
                        try {
                            const cert = proto.VerifiedNameCertificate
                                ? proto.VerifiedNameCertificate.decode(content)
                                : null;
                            if (cert) {
                                const details = proto.VerifiedNameCertificate.Details
                                    ? proto.VerifiedNameCertificate.Details.decode(cert.details)
                                    : null;
                                if (details) {
                                    fullMessage.verifiedBizName = details.verifiedName;
                                }
                            }
                        } catch {}
                    }

                    if (tag === 'unavailable' && attrs?.type === 'view_once') {
                        fullMessage.key.isViewOnce = true;
                    }

                    if (attrs?.count && tag === 'enc') {
                        fullMessage.retryCount = Number(attrs.count);
                    }

                    if (tag !== 'enc' && tag !== 'plaintext') {
                        continue;
                    }

                    if (!(content instanceof Uint8Array) && !Buffer.isBuffer(content)) {
                        continue;
                    }

                    decryptables += 1;
                    let msgBuffer;

                    try {
                        const e2eType = tag === 'plaintext' ? 'plaintext' : attrs.type;

                        switch (e2eType) {
                            case 'skmsg':
                                msgBuffer = await repository.decryptGroupMessage({
                                    group: sender,
                                    authorJid: author,
                                    msg: content
                                });
                                break;
                            case 'pkmsg':
                            case 'msg':
                                msgBuffer = await repository.decryptMessage({
                                    jid: author,
                                    type: e2eType,
                                    ciphertext: content
                                });
                                break;
                            case 'plaintext':
                                msgBuffer = content;
                                break;
                            default:
                                throw new Error(`Unknown e2e type: ${e2eType}`);
                        }

                        let msg;
                        msg = proto.Message.decode(Buffer.from(msgBuffer));

                        msg = msg.deviceSentMessage?.message || msg;

                        if (msg.senderKeyDistributionMessage) {
                            try {
                                await repository.processSenderKeyDistributionMessage({
                                    authorJid: author,
                                    item: msg.senderKeyDistributionMessage
                                });
                            } catch (err) {
                                if (logger) logger.error?.({ key: fullMessage.key, err }, 'failed to process sender key distribution message');
                            }
                        }

                        if (fullMessage.message) {
                            Object.assign(fullMessage.message, msg);
                        } else {
                            fullMessage.message = msg;
                        }
                    } catch (err) {
                        if (logger) logger.error?.({
                            key: fullMessage.key,
                            err,
                            messageType: tag === 'plaintext' ? 'plaintext' : attrs.type,
                            sender,
                            author,
                            isSessionRecordError: isSessionRecordError(err)
                        }, 'failed to decrypt message');
                        fullMessage.messageStubType = 'CIPHERTEXT';
                        fullMessage.messageStubParameters = [err.message?.toString() || 'unknown error'];
                    }
                }
            }

            if (!decryptables && !fullMessage.key?.isViewOnce) {
                fullMessage.messageStubType = 'CIPHERTEXT';
                fullMessage.messageStubParameters = [NO_MESSAGE_FOUND_ERROR_TEXT];
            }
        }
    };
}

function isSessionRecordError(error) {
    const errorMessage = error?.message || error?.toString() || '';
    return DECRYPTION_RETRY_CONFIG.sessionRecordErrors.some(
        errorPattern => errorMessage.includes(errorPattern)
    );
}

function cleanMessage(message, meId, meLid) {
    if (message.key?.remoteJid) {
        message.key.remoteJid = jidNormalizedUser(message.key.remoteJid);
    }
    if (message.key?.participant) {
        message.key.participant = jidNormalizedUser(message.key.participant);
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
    if (isJidBroadcastFn(remoteJid) && !isJidStatusBroadcast(remoteJid) && !fromMe) {
        return participant;
    }
    return remoteJid;
}

function getKeyAuthor(key, meId) {
    return (key.fromMe ? meId : key.participant || key.remoteJid) || meId;
}

function decryptPollVote({ encPayload, encIv }, { pollCreatorJid, pollMsgId, pollEncKey, voterJid }) {
    const sign = Buffer.concat([
        Buffer.from(pollMsgId),
        Buffer.from(pollCreatorJid),
        Buffer.from(voterJid),
        Buffer.from('Poll Vote'),
        new Uint8Array([1])
    ]);
    const key0 = hmacSign(new Uint8Array(32), pollEncKey, 'sha256');
    const decKey = hmacSign(sign, key0, 'sha256');
    const aad = Buffer.from(`${pollMsgId}\u0000${voterJid}`);
    const decrypted = aesDecryptGCM(encPayload, decKey, encIv, aad);
    const proto = loadProto();
    if (proto.Message?.PollVoteMessage) {
        return proto.Message.PollVoteMessage.decode(decrypted);
    }
    return { selectedOptions: [] };
}

async function processMessage(message, ctx) {
    const { ev, creds, signalRepository, logger, getMessage } = ctx;
    const meId = creds.me?.id;
    const meLid = creds.me?.lid;

    const chat = { id: jidNormalizedUser(getChatId(message.key)) };
    const realMsg = isRealMessage(message);

    if (realMsg) {
        chat.messages = [{ message }];
        chat.conversationTimestamp = +(message.messageTimestamp || Math.floor(Date.now() / 1000));
        if (shouldIncrementChatUnread(message)) {
            chat.unreadCount = (chat.unreadCount || 0) + 1;
        }
    }

    const content = normalizeMessageContent(message.message);
    const { accountSettings } = creds;

    if ((realMsg || content?.reactionMessage?.key?.fromMe) && accountSettings?.unarchiveChats) {
        chat.archived = false;
        chat.readOnly = false;
    }

    const protocolMsg = content?.protocolMessage;
    if (protocolMsg) {
        await handleProtocolMessage(protocolMsg, message, chat, ctx);
    } else if (content?.reactionMessage) {
        const reaction = {
            ...content.reactionMessage,
            key: message.key
        };
        ev.emit('messages.reaction', [{
            reaction,
            key: content.reactionMessage?.key
        }]);
    } else if (content?.pollUpdateMessage) {
        await handlePollUpdate(content.pollUpdateMessage, message, ctx);
    } else if (message.messageStubType) {
        handleMessageStub(message, chat, ev, meId);
    }

    if (Object.keys(chat).length > 1) {
        ev.emit('chats.update', [chat]);
    }
}

async function handleProtocolMessage(protocolMsg, message, chat, ctx) {
    const { ev, creds, logger, keys } = ctx;
    const meId = creds.me?.id;

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

        case 3:
            if (protocolMsg.historySyncNotification) {
                const histNotification = protocolMsg.historySyncNotification;
                if (logger) logger.info?.({ histNotification, id: message.key.id }, 'got history notification');
                ev.emit('creds.update', {
                    processedHistoryMessages: [
                        ...(creds.processedHistoryMessages || []),
                        { key: message.key, messageTimestamp: message.messageTimestamp }
                    ]
                });
            }
            break;

        case 6:
            Object.assign(chat, {
                ephemeralSettingTimestamp: +(message.messageTimestamp || 0),
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
                        ? Math.floor(Number(protocolMsg.timestampMs) / 1000)
                        : message.messageTimestamp
                }
            }]);
            break;

        case 15:
            const appStateKeys = protocolMsg.appStateSyncKeyShare?.keys;
            if (appStateKeys?.length && keys) {
                const newKeys = [];
                for (const { keyData, keyId } of appStateKeys) {
                    const strKeyId = Buffer.from(keyId.keyId).toString('base64');
                    newKeys.push(strKeyId);
                    await keys.set({ 'app-state-sync-key': { [strKeyId]: keyData } });
                }
                if (logger) logger.info?.({ newKeys }, 'injecting new app state sync keys');
                ev.emit('creds.update', { myAppStateKeyId: newKeys[newKeys.length - 1] });
            }
            break;

        case 17:
            const response = protocolMsg.peerDataOperationRequestResponseMessage;
            if (response) {
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
}

async function handlePollUpdate(pollUpdateMsg, message, ctx) {
    const { ev, creds, getMessage, logger } = ctx;
    const creationMsgKey = pollUpdateMsg.pollCreationMessageKey;
    if (!creationMsgKey || !getMessage) return;

    const pollMsg = await getMessage(creationMsgKey);
    if (pollMsg) {
        try {
            const meIdNormalised = jidNormalizedUser(creds.me?.id);
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
                            senderTimestampMs: Number(pollUpdateMsg.senderTimestampMs || 0)
                        }]
                    }
                }]);
            }
        } catch (err) {
            if (logger) logger.warn?.({ err, creationMsgKey }, 'failed to decrypt poll vote');
        }
    }
}

function handleMessageStub(message, chat, ev, meId) {
    const jid = message.key?.remoteJid;
    let participants;

    const emitParticipantsUpdate = (action) => ev.emit('group-participants.update', {
        id: jid,
        author: message.key.participant,
        participants,
        action
    });

    const emitGroupUpdate = (update) => {
        ev.emit('groups.update', [{ id: jid, ...update, author: message.key.participant }]);
    };

    const participantsIncludesMe = () => {
        if (!participants) return false;
        return participants.some(p => {
            const pJid = typeof p === 'object' ? (p.phoneNumber || p.jid || p) : p;
            return areJidsSameUser(meId, pJid);
        });
    };

    const stubType = message.messageStubType;
    const stubParams = message.messageStubParameters || [];

    switch (stubType) {
        case 'GROUP_PARTICIPANT_CHANGE_NUMBER':
            participants = stubParams;
            emitParticipantsUpdate('modify');
            break;
        case 'GROUP_PARTICIPANT_LEAVE':
        case 'GROUP_PARTICIPANT_REMOVE':
            participants = stubParams;
            emitParticipantsUpdate('remove');
            if (participantsIncludesMe()) {
                chat.readOnly = true;
            }
            break;
        case 'GROUP_PARTICIPANT_ADD':
        case 'GROUP_PARTICIPANT_INVITE':
        case 'GROUP_PARTICIPANT_ADD_REQUEST_JOIN':
            participants = stubParams;
            if (participantsIncludesMe()) {
                chat.readOnly = false;
            }
            emitParticipantsUpdate('add');
            break;
        case 'GROUP_PARTICIPANT_DEMOTE':
            participants = stubParams;
            emitParticipantsUpdate('demote');
            break;
        case 'GROUP_PARTICIPANT_PROMOTE':
            participants = stubParams;
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
    }
}

async function handleMexNewsletterNotification(node, ev, logger) {
    const mexNode = getBinaryNodeChild(node, 'mex');
    if (!mexNode?.content) {
        if (logger) logger.warn?.({ node }, 'Invalid mex newsletter notification');
        return;
    }

    let data;
    try {
        const raw = Buffer.isBuffer(mexNode.content)
            ? mexNode.content.toString('utf-8')
            : mexNode.content.toString();
        data = JSON.parse(raw);
    } catch (parseErr) {
        if (logger) logger.error?.({ err: parseErr, node }, 'Failed to parse mex newsletter notification');
        return;
    }

    const operation = data?.operation;
    const updates = data?.updates;
    if (!updates || !operation) {
        if (logger) logger.warn?.({ data }, 'Invalid mex newsletter notification content');
        return;
    }

    if (logger) logger.info?.({ operation, updates }, 'got mex newsletter notification');

    switch (operation) {
        case 'NotificationNewsletterUpdate':
            for (const update of updates) {
                if (update.jid && update.settings && Object.keys(update.settings).length > 0) {
                    ev.emit('newsletter-settings.update', {
                        id: update.jid,
                        update: update.settings
                    });
                }
            }
            break;
        case 'NotificationNewsletterAdminPromote':
            for (const update of updates) {
                if (update.jid && update.user) {
                    ev.emit('newsletter-participants.update', {
                        id: update.jid,
                        author: node.attrs.from,
                        user: update.user,
                        new_role: 'ADMIN',
                        action: 'promote'
                    });
                }
            }
            break;
        default:
            if (logger) logger.info?.({ operation, data }, 'Unhandled mex newsletter notification');
            break;
    }
}

async function handleNewsletterNotification(node, ev, logger, upsertMessage) {
    const from = node.attrs.from;
    const children = getAllBinaryNodeChildren(node);
    const child = children[0];
    if (!child) return;

    const author = node.attrs.participant;
    if (logger) logger.info?.({ from, childTag: child.tag }, 'got newsletter notification');

    switch (child.tag) {
        case 'reaction': {
            const reactionCode = getBinaryNodeChildString(child, 'reaction');
            ev.emit('newsletter.reaction', {
                id: from,
                server_id: child.attrs.message_id,
                reaction: {
                    code: reactionCode,
                    count: 1
                }
            });
            break;
        }
        case 'view': {
            const viewCount = parseInt(
                child.content?.toString?.() || '0',
                10
            );
            ev.emit('newsletter.view', {
                id: from,
                server_id: child.attrs.message_id,
                count: viewCount
            });
            break;
        }
        case 'participant': {
            ev.emit('newsletter-participants.update', {
                id: from,
                author,
                user: child.attrs.jid,
                action: child.attrs.action,
                new_role: child.attrs.role
            });
            break;
        }
        case 'update': {
            const settingsNode = getBinaryNodeChild(child, 'settings');
            if (settingsNode) {
                const updateData = {};
                const nameNode = getBinaryNodeChild(settingsNode, 'name');
                if (nameNode?.content) {
                    updateData.name = Buffer.isBuffer(nameNode.content)
                        ? nameNode.content.toString('utf-8')
                        : nameNode.content.toString();
                }
                const descNode = getBinaryNodeChild(settingsNode, 'description');
                if (descNode?.content) {
                    updateData.description = Buffer.isBuffer(descNode.content)
                        ? descNode.content.toString('utf-8')
                        : descNode.content.toString();
                }
                ev.emit('newsletter-settings.update', {
                    id: from,
                    update: updateData
                });
            }
            break;
        }
        case 'message': {
            const plaintextNode = getBinaryNodeChild(child, 'plaintext');
            if (plaintextNode?.content && upsertMessage) {
                try {
                    const proto = loadProto();
                    const contentBuf = typeof plaintextNode.content === 'string'
                        ? Buffer.from(plaintextNode.content, 'binary')
                        : Buffer.from(plaintextNode.content);
                    const decodedMsg = proto.Message.decode(contentBuf);
                    const fullMsg = {
                        key: {
                            remoteJid: from,
                            id: child.attrs.message_id || child.attrs.server_id,
                            fromMe: false
                        },
                        message: decodedMsg,
                        messageTimestamp: +child.attrs.t
                    };
                    await upsertMessage(fullMsg, 'append');
                    if (logger) logger.info?.('Processed plaintext newsletter message');
                } catch (decodeErr) {
                    if (logger) logger.error?.({ err: decodeErr }, 'Failed to decode plaintext newsletter message');
                }
            }
            break;
        }
        default:
            if (logger) logger.warn?.({ tag: child.tag }, 'Unknown newsletter notification type');
            break;
    }
}

async function handleEncryptNotification(node, ev, authState, logger, uploadPreKeys, assertSessions) {
    const from = node.attrs.from;
    if (from === S_WHATSAPP_NET) {
        const countChild = getBinaryNodeChild(node, 'count');
        if (countChild) {
            const count = +(countChild.attrs?.value || 0);
            const shouldUpload = count < 5;
            if (logger) logger.debug?.({ count, shouldUpload }, 'recv pre-key count');
            if (shouldUpload && uploadPreKeys) {
                await uploadPreKeys();
            }
        }
    } else {
        const identityNode = getBinaryNodeChild(node, 'identity');
        if (identityNode) {
            if (logger) logger.info?.({ jid: from }, 'identity changed');
            if (assertSessions) {
                try {
                    await assertSessions([from], true);
                } catch (assertErr) {
                    if (logger) logger.warn?.({ err: assertErr, jid: from }, 'failed to assert sessions after identity change');
                }
            }
        } else {
            if (logger) logger.info?.({ node }, 'unknown encrypt notification');
        }
    }
}

function handleGroupNotification(fullNode, child, msg, ev) {
    const actingParticipantLid = fullNode.attrs.participant;
    const actingParticipantPn = fullNode.attrs.participant_pn;
    const affectedParticipantLid = getBinaryNodeChild(child, 'participant')?.attrs?.jid || actingParticipantLid;
    const affectedParticipantPn = getBinaryNodeChild(child, 'participant')?.attrs?.phone_number || actingParticipantPn;

    switch (child?.tag) {
        case 'create': {
            const { extractGroupMetadata } = require('./groups');
            const metadata = extractGroupMetadata(child);
            msg.messageStubType = 'GROUP_CREATE';
            msg.messageStubParameters = [metadata.subject];
            msg.key = { participant: metadata.owner, participantAlt: metadata.ownerPn };
            ev.emit('chats.upsert', [{
                id: metadata.id,
                name: metadata.subject,
                conversationTimestamp: metadata.creation
            }]);
            ev.emit('groups.upsert', [{
                ...metadata,
                author: actingParticipantLid,
                authorPn: actingParticipantPn
            }]);
            break;
        }
        case 'ephemeral':
        case 'not_ephemeral': {
            const proto = loadProto();
            msg.message = {
                protocolMessage: {
                    type: 6,
                    ephemeralExpiration: +(child.attrs.expiration || 0)
                }
            };
            break;
        }
        case 'modify': {
            const oldNumber = getBinaryNodeChildren(child, 'participant').map(p => p.attrs.jid);
            msg.messageStubParameters = oldNumber || [];
            msg.messageStubType = 'GROUP_PARTICIPANT_CHANGE_NUMBER';
            break;
        }
        case 'promote':
        case 'demote':
        case 'remove':
        case 'add':
        case 'leave': {
            const stubName = 'GROUP_PARTICIPANT_' + child.tag.toUpperCase();
            msg.messageStubType = stubName;
            const participantNodes = getBinaryNodeChildren(child, 'participant');
            const participants = participantNodes.map(({ attrs }) => ({
                id: attrs.jid,
                phoneNumber: isLidUser(attrs.jid) && isPnUser(attrs.phone_number) ? attrs.phone_number : undefined,
                lid: isPnUser(attrs.jid) && isLidUser(attrs.lid) ? attrs.lid : undefined,
                admin: attrs.type || null
            }));
            if (
                participants.length === 1 &&
                (areJidsSameUser(participants[0].id, actingParticipantLid) ||
                    areJidsSameUser(participants[0].id, actingParticipantPn)) &&
                child.tag === 'remove'
            ) {
                msg.messageStubType = 'GROUP_PARTICIPANT_LEAVE';
            }
            msg.messageStubParameters = participants.map(a => JSON.stringify(a));
            break;
        }
        case 'subject':
            msg.messageStubType = 'GROUP_CHANGE_SUBJECT';
            msg.messageStubParameters = [child.attrs.subject];
            break;
        case 'description': {
            const descBody = getBinaryNodeChild(child, 'body');
            const description = descBody?.content?.toString();
            msg.messageStubType = 'GROUP_CHANGE_DESCRIPTION';
            msg.messageStubParameters = description ? [description] : undefined;
            break;
        }
        case 'announcement':
        case 'not_announcement':
            msg.messageStubType = 'GROUP_CHANGE_ANNOUNCE';
            msg.messageStubParameters = [child.tag === 'announcement' ? 'on' : 'off'];
            break;
        case 'locked':
        case 'unlocked':
            msg.messageStubType = 'GROUP_CHANGE_RESTRICT';
            msg.messageStubParameters = [child.tag === 'locked' ? 'on' : 'off'];
            break;
        case 'invite':
            msg.messageStubType = 'GROUP_CHANGE_INVITE_LINK';
            msg.messageStubParameters = [child.attrs.code];
            break;
        case 'member_add_mode': {
            const addMode = child.content;
            if (addMode) {
                msg.messageStubType = 'GROUP_MEMBER_ADD_MODE';
                msg.messageStubParameters = [addMode.toString()];
            }
            break;
        }
        case 'membership_approval_mode': {
            const approvalMode = getBinaryNodeChild(child, 'group_join');
            if (approvalMode) {
                msg.messageStubType = 'GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE';
                msg.messageStubParameters = [approvalMode.attrs.state];
            }
            break;
        }
        case 'created_membership_requests':
            msg.messageStubType = 'GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD';
            msg.messageStubParameters = [
                JSON.stringify({ lid: affectedParticipantLid, pn: affectedParticipantPn }),
                'created',
                child.attrs.request_method
            ];
            break;
        case 'revoked_membership_requests': {
            const isDenied = areJidsSameUser(affectedParticipantLid, actingParticipantLid);
            msg.messageStubType = 'GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD';
            msg.messageStubParameters = [
                JSON.stringify({ lid: affectedParticipantLid, pn: affectedParticipantPn }),
                isDenied ? 'revoked' : 'rejected'
            ];
            break;
        }
    }
}

async function processNotification(node, ctx) {
    const { ev, authState, logger, uploadPreKeys, assertSessions, upsertMessage, resyncAppState } = ctx;
    const result = {};
    const children = getAllBinaryNodeChildren(node);
    const child = children[0];
    const nodeType = node.attrs.type;
    const from = jidNormalizedUser(node.attrs.from);

    switch (nodeType) {
        case 'newsletter':
            await handleNewsletterNotification(node, ev, logger, upsertMessage);
            break;
        case 'mex':
            await handleMexNewsletterNotification(node, ev, logger);
            break;
        case 'w:gp2':
            handleGroupNotification(node, child, result, ev);
            break;
        case 'encrypt':
            await handleEncryptNotification(node, ev, authState, logger, uploadPreKeys, assertSessions);
            break;
        case 'devices': {
            if (child) {
                const deviceNodes = getBinaryNodeChildren(child, 'device');
                if (
                    areJidsSameUser(child.attrs?.jid, authState.creds.me?.id) ||
                    areJidsSameUser(child.attrs?.lid, authState.creds.me?.lid)
                ) {
                    const deviceData = deviceNodes.map(d => ({ id: d.attrs.jid, lid: d.attrs.lid }));
                    if (logger) logger.info?.({ deviceData }, 'my own devices changed');
                }
            }
            break;
        }
        case 'server_sync': {
            const updateNode = getBinaryNodeChild(node, 'collection');
            if (updateNode && resyncAppState) {
                const collectionName = updateNode.attrs.name;
                await resyncAppState([collectionName], false);
            }
            break;
        }
        case 'picture': {
            const setPicture = getBinaryNodeChild(node, 'set');
            const delPicture = getBinaryNodeChild(node, 'delete');
            ev.emit('contacts.update', [{
                id: from || (setPicture || delPicture)?.attrs?.hash || '',
                imgUrl: setPicture ? 'changed' : 'removed'
            }]);
            if (isJidGroup(from)) {
                const picNode = setPicture || delPicture;
                result.messageStubType = 'GROUP_CHANGE_ICON';
                if (setPicture) {
                    result.messageStubParameters = [setPicture.attrs.id];
                }
                result.participant = picNode?.attrs?.author;
                result.key = {
                    ...(result.key || {}),
                    participant: setPicture?.attrs?.author
                };
            }
            break;
        }
        case 'account_sync': {
            if (child) {
                if (child.tag === 'disappearing_mode') {
                    const newDuration = +child.attrs.duration;
                    const timestamp = +child.attrs.t;
                    if (logger) logger.info?.({ newDuration }, 'updated account disappearing mode');
                    ev.emit('creds.update', {
                        accountSettings: {
                            ...(authState.creds.accountSettings || {}),
                            defaultDisappearingMode: {
                                ephemeralExpiration: newDuration,
                                ephemeralSettingTimestamp: timestamp
                            }
                        }
                    });
                } else if (child.tag === 'blocklist') {
                    const blocklistItems = getBinaryNodeChildren(child, 'item');
                    for (const { attrs } of blocklistItems) {
                        const blocklist = [attrs.jid];
                        const type = attrs.action === 'block' ? 'add' : 'remove';
                        ev.emit('blocklist.update', { blocklist, type });
                    }
                } else if (child.tag === 'privacy') {
                    if (logger) logger.info?.({ child: child.tag }, 'privacy notification received');
                    ev.emit('privacy.update', { node: child });
                }
            }
            break;
        }
        case 'privacy_token': {
            const tokensNode = getBinaryNodeChild(node, 'tokens');
            if (tokensNode && authState.keys) {
                const tokenNodes = getBinaryNodeChildren(tokensNode, 'token');
                for (const tokenNode of tokenNodes) {
                    const { attrs: tAttrs, content: tContent } = tokenNode;
                    if (tAttrs.type === 'trusted_contact' && (Buffer.isBuffer(tContent) || tContent instanceof Uint8Array)) {
                        if (logger) logger.debug?.({ from, timestamp: tAttrs.t }, 'received trusted contact token');
                        await authState.keys.set({
                            tctoken: { [from]: { token: Buffer.from(tContent), timestamp: tAttrs.t } }
                        });
                    }
                }
            }
            break;
        }
        case 'mediaretry': {
            const retryChild = getBinaryNodeChild(node, 'rmr');
            if (retryChild) {
                const retryEvent = {
                    key: {
                        remoteJid: from,
                        id: retryChild.attrs?.id,
                        fromMe: true
                    }
                };
                const errorChild = getBinaryNodeChild(node, 'error');
                if (errorChild) {
                    const errCode = +(errorChild.attrs?.code || 0);
                    retryEvent.error = new Error('Media re-upload failed (' + errCode + ')');
                } else {
                    const encNode = getBinaryNodeChild(node, 'encrypt');
                    const ciphertext = getBinaryNodeChildBuffer(encNode, 'enc_p');
                    const iv = getBinaryNodeChildBuffer(encNode, 'enc_iv');
                    if (ciphertext && iv) {
                        retryEvent.media = { ciphertext, iv };
                    } else {
                        retryEvent.error = new Error('Media re-upload response missing encrypted payload');
                    }
                }
                ev.emit('messages.media-update', [retryEvent]);
            }
            break;
        }
        default:
            if (logger) logger.debug?.({ type: nodeType, from }, 'unhandled notification type');
            break;
    }

    if (Object.keys(result).length) {
        return result;
    }
}

function handleBadAck(node, ev, logger) {
    const { attrs } = node;
    const key = { remoteJid: attrs.from, fromMe: true, id: attrs.id };

    if (attrs.error) {
        if (logger) logger.warn?.({ attrs }, 'received error in ack');
        ev.emit('messages.update', [{
            key,
            update: {
                status: MSG_STATUS.ERROR,
                messageStubParameters: [attrs.error]
            }
        }]);
    }
}

function handleCallEvent(node, ev, logger, callCache) {
    const { attrs } = node;
    const children = getAllBinaryNodeChildren(node);
    const infoChild = children[0];

    if (!infoChild) {
        if (logger) logger.warn?.({ node }, 'Missing call info in call node');
        return null;
    }

    const status = deriveCallStatus(infoChild);
    const callId = infoChild.attrs?.['call-id'];
    const caller = infoChild.attrs?.from || infoChild.attrs?.['call-creator'];

    const call = {
        chatId: attrs.from,
        from: caller,
        id: callId,
        date: new Date(+(attrs.t || 0) * 1000),
        offline: !!attrs.offline,
        status
    };

    if (status === 'offer') {
        call.isVideo = !!getBinaryNodeChild(infoChild, 'video');
        call.isGroup = infoChild.attrs?.type === 'group' || !!infoChild.attrs?.['group-jid'];
        call.groupJid = infoChild.attrs?.['group-jid'];
        if (callCache) callCache.set(call.id, call);
    }

    if (callCache) {
        const existing = callCache.get(call.id);
        if (existing) {
            call.isVideo = existing.isVideo;
            call.isGroup = existing.isGroup;
        }
    }

    if (status === 'reject' || status === 'accept' || status === 'timeout' || status === 'terminate') {
        if (callCache) callCache.delete(call.id);
    }

    ev.emit('call', [call]);
    return call;
}

function makeOfflineNodeProcessor(handlers, logger) {
    const pendingNodes = [];
    let processing = false;

    function enqueue(type, node) {
        pendingNodes.push({ type, node });
        if (processing) return;
        processing = true;

        const drainQueue = async () => {
            while (pendingNodes.length > 0) {
                const { type: nodeType, node: nextNode } = pendingNodes.shift();
                const handler = handlers.get(nodeType);
                if (!handler) {
                    if (logger) logger.warn?.({ type: nodeType }, 'unknown offline node type');
                    continue;
                }
                try {
                    await handler(nextNode);
                } catch (err) {
                    if (logger) logger.error?.({ err, type: nodeType }, 'error processing offline node');
                }
            }
            processing = false;
        };

        drainQueue().catch(err => {
            if (logger) logger.error?.({ err }, 'unhandled error in offline node processor');
            processing = false;
        });
    }

    return { enqueue };
}

async function processNodeWithBuffer(node, identifier, handler, ev, logger) {
    ev.buffer();
    try {
        await handler(node);
    } catch (err) {
        if (logger) logger.error?.({ err, identifier }, 'error in processNodeWithBuffer');
    }
    ev.flush();
}

function generateMissedCallMessage(call) {
    const ts = Math.floor(call.date.getTime() / 1000);
    const msg = {
        key: {
            remoteJid: call.chatId,
            id: call.id,
            fromMe: false
        },
        messageTimestamp: ts
    };

    if (call.status === 'timeout') {
        if (call.isGroup) {
            msg.messageStubType = call.isVideo
                ? 'CALL_MISSED_GROUP_VIDEO'
                : 'CALL_MISSED_GROUP_VOICE';
        } else {
            msg.messageStubType = call.isVideo
                ? 'CALL_MISSED_VIDEO'
                : 'CALL_MISSED_VOICE';
        }
    } else if (call.status === 'offer' && call.isGroup) {
        msg.message = { call: { callKey: Buffer.from(call.id || '') } };
    } else {
        return null;
    }

    return msg;
}

module.exports = {
    decodeMessageNode,
    decryptMessageNode,
    processMessage,
    cleanMessage,
    isRealMessage,
    shouldIncrementChatUnread,
    getChatId,
    getKeyAuthor,
    decryptPollVote,
    extractAddressingContext,
    handleProtocolMessage,
    handlePollUpdate,
    handleMessageStub,
    isSessionRecordError,
    handleMexNewsletterNotification,
    handleNewsletterNotification,
    handleEncryptNotification,
    handleGroupNotification,
    processNotification,
    handleBadAck,
    handleCallEvent,
    deriveCallStatus,
    makeOfflineNodeProcessor,
    processNodeWithBuffer,
    getStatusFromReceiptType,
    extractHistorySyncMsg,
    getBinaryNodeChildString,
    generateMissedCallMessage,
    NO_MESSAGE_FOUND_ERROR_TEXT,
    MISSING_KEYS_ERROR_TEXT,
    DECRYPTION_RETRY_CONFIG,
    NACK_REASONS,
    MSG_STATUS,
    RECEIPT_STATUS_MAP,
};
