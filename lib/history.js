'use strict';

const { promisify } = require('util');
const { inflate } = require('zlib');
const path = require('path');

const inflatePromise = promisify(inflate);

let _proto = null;
function loadProto() {
    if (_proto) return _proto;
    const protobuf = require('protobufjs');
    const root = protobuf.loadSync(path.join(__dirname, '..', 'proto', 'whatsapp.proto'));
    _proto = {
        HistorySync: root.lookupType('proto.HistorySync'),
    };
    return _proto;
}

const WAMessageStubType = {
    BIZ_PRIVACY_MODE_TO_BSP: 129,
    BIZ_PRIVACY_MODE_TO_FB: 128,
};

function toNumber(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    if (value && typeof value === 'object' && ('low' in value)) {
        return (value.high || 0) * 4294967296 + (value.low >>> 0);
    }
    return Number(value) || 0;
}

async function downloadHistory(msg, options) {
    const { downloadContentFromMessage } = require('./messages-media');
    const stream = await downloadContentFromMessage(msg, 'md-msg-hist', { options });
    const bufferArray = [];
    for await (const chunk of stream) {
        bufferArray.push(chunk);
    }
    let buffer = Buffer.concat(bufferArray);
    buffer = await inflatePromise(buffer);
    const proto = loadProto();
    const syncData = proto.HistorySync.decode(buffer);
    return syncData;
}

function processHistoryMessage(item) {
    const messages = [];
    const contacts = [];
    const chats = [];

    const { normalizeMessageContent } = require('./messages');

    const syncType = item.syncType;

    const INITIAL_BOOTSTRAP = 0;
    const INITIAL_STATUS_V3 = 1;
    const FULL = 2;
    const RECENT = 3;
    const PUSH_NAME = 4;
    const ON_DEMAND = 6;

    switch (syncType) {
        case INITIAL_BOOTSTRAP:
        case RECENT:
        case FULL:
        case ON_DEMAND:
            for (const chat of (item.conversations || [])) {
                contacts.push({
                    id: chat.id,
                    name: chat.name || undefined,
                    lid: chat.lidJid || undefined,
                    phoneNumber: chat.pnJid || undefined,
                });

                const msgs = chat.messages || [];
                delete chat.messages;

                for (const msgItem of msgs) {
                    const message = msgItem.message;
                    if (!message) continue;
                    messages.push(message);

                    if (!chat.messages?.length) {
                        chat.messages = [{ message }];
                    }

                    if (!message.key.fromMe && !chat.lastMessageRecvTimestamp) {
                        chat.lastMessageRecvTimestamp = toNumber(message.messageTimestamp);
                    }

                    if ((message.messageStubType === WAMessageStubType.BIZ_PRIVACY_MODE_TO_BSP ||
                        message.messageStubType === WAMessageStubType.BIZ_PRIVACY_MODE_TO_FB) &&
                        message.messageStubParameters?.[0]) {
                        contacts.push({
                            id: message.key.participant || message.key.remoteJid,
                            verifiedName: message.messageStubParameters[0],
                        });
                    }
                }

                chats.push({ ...chat });
            }
            break;

        case PUSH_NAME:
            for (const c of (item.pushnames || [])) {
                contacts.push({ id: c.id, notify: c.pushname });
            }
            break;
    }

    return {
        chats,
        contacts,
        messages,
        syncType,
        progress: item.progress,
    };
}

async function downloadAndProcessHistorySyncNotification(msg, options) {
    let historyMsg;
    if (msg.initialHistBootstrapInlinePayload) {
        historyMsg = loadProto().HistorySync.decode(
            await inflatePromise(msg.initialHistBootstrapInlinePayload)
        );
    } else {
        historyMsg = await downloadHistory(msg, options);
    }
    return processHistoryMessage(historyMsg);
}

function getHistoryMsg(message) {
    if (!message) return undefined;
    const { normalizeMessageContent } = require('./messages');
    const normalizedContent = normalizeMessageContent(message);
    return normalizedContent?.protocolMessage?.historySyncNotification;
}

module.exports = {
    downloadHistory,
    processHistoryMessage,
    downloadAndProcessHistorySyncNotification,
    getHistoryMsg,
};
