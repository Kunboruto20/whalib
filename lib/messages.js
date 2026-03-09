'use strict';

const nodeCrypto = require('crypto');
const path = require('path');

const { areJidsSameUser, isJidGroup, isJidStatusBroadcast, isJidNewsletter, jidNormalizedUser } = require('./jid-utils');

const URL_MATCH_REGEX = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)/;
const WA_DEFAULT_EPHEMERAL = 604800;

let _proto = null;
function loadProto() {
    if (_proto) return _proto;
    const protobuf = require('protobufjs');
    const root = protobuf.loadSync(path.join(__dirname, '..', 'proto', 'whatsapp.proto'));
    _proto = {
        Message: root.lookupType('proto.Message'),
        MessageKey: root.lookupType('proto.MessageKey'),
        WebMessageInfo: root.lookupType('proto.WebMessageInfo'),
        ContextInfo: root.lookupType('proto.ContextInfo'),
        HandshakeMessage: root.lookupType('proto.HandshakeMessage'),
        ClientPayload: root.lookupType('proto.ClientPayload'),
        DeviceProps: root.lookupType('proto.DeviceProps'),
        ADVSignedDeviceIdentity: root.lookupType('proto.ADVSignedDeviceIdentity'),
        ADVSignedDeviceIdentityHMAC: root.lookupType('proto.ADVSignedDeviceIdentityHMAC'),
        ADVDeviceIdentity: root.lookupType('proto.ADVDeviceIdentity'),
    };
    try {
        _proto.VerifiedNameCertificate = root.lookupType('proto.VerifiedNameCertificate');
    } catch {}
    try {
        _proto.HistorySyncNotification = root.lookupType('proto.Message.HistorySyncNotification');
    } catch {}
    try {
        _proto.AppStateSyncKeyShare = root.lookupType('proto.Message.AppStateSyncKeyShare');
    } catch {}
    return _proto;
}

function generateMessageIDV2(userId) {
    const data = Buffer.alloc(8 + 20 + 16);
    data.writeBigUInt64BE(BigInt(Date.now()), 0);
    if (userId) {
        const userBytes = Buffer.from(String(userId).replace(/@.*$/, ''), 'utf-8');
        userBytes.copy(data, 8, 0, Math.min(userBytes.length, 20));
    }
    const randBytes = nodeCrypto.randomBytes(16);
    randBytes.copy(data, 28);
    const hash = nodeCrypto.createHash('sha256').update(data).digest();
    return '3EB0' + hash.slice(0, 8).toString('hex').toUpperCase();
}

function generateMessageID() {
    return generateMessageIDV2();
}

const MESSAGE_TYPE_LIST = [
    'conversation',
    'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage',
    'stickerMessage', 'contactMessage', 'contactsArrayMessage',
    'locationMessage', 'liveLocationMessage', 'extendedTextMessage',
    'reactionMessage', 'pollCreationMessage', 'pollCreationMessageV2',
    'pollCreationMessageV3', 'pollUpdateMessage',
    'protocolMessage', 'senderKeyDistributionMessage',
    'deviceSentMessage', 'messageContextInfo',
    'listMessage', 'listResponseMessage',
    'buttonsMessage', 'buttonsResponseMessage',
    'templateMessage', 'templateButtonReplyMessage',
    'interactiveMessage', 'productMessage',
    'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
    'editedMessage', 'eventMessage',
    'ptvMessage', 'newsletterAdminInviteMessage',
    'groupInviteMessage', 'orderMessage',
    'documentWithCaptionMessage',
    'encReactionMessage', 'encEventResponseMessage',
    'keepInChatMessage', 'pinInChatMessage',
    'requestPhoneNumberMessage',
];

function extractUrlFromText(text) {
    if (!text) return undefined;
    const match = text.match(URL_MATCH_REGEX);
    return match ? match[0] : undefined;
}

async function generateLinkPreviewIfRequired(text, getUrlInfo, logger) {
    const url = extractUrlFromText(text);
    if (getUrlInfo && url) {
        try {
            return await getUrlInfo(url);
        } catch (err) {
            if (logger) logger.warn({ trace: err.stack }, 'url info generation failed');
        }
    }
    return undefined;
}

function getContentType(message) {
    if (!message) return undefined;
    const keys = Object.keys(message);
    const found = keys.find(k =>
        (k === 'conversation' || k.includes('Message')) && k !== 'senderKeyDistributionMessage'
    );
    return found;
}

function getFutureProofInner(message) {
    return message?.ephemeralMessage
        || message?.viewOnceMessage
        || message?.documentWithCaptionMessage
        || message?.viewOnceMessageV2
        || message?.viewOnceMessageV2Extension
        || message?.editedMessage;
}

function normalizeMessageContent(content) {
    if (!content) return undefined;
    for (let depth = 0; depth < 5; depth++) {
        const wrapper = getFutureProofInner(content);
        if (!wrapper) break;
        content = wrapper.message;
    }
    return content;
}

function extractFromTemplateContent(tmpl) {
    if (tmpl.imageMessage) return { imageMessage: tmpl.imageMessage };
    if (tmpl.documentMessage) return { documentMessage: tmpl.documentMessage };
    if (tmpl.videoMessage) return { videoMessage: tmpl.videoMessage };
    if (tmpl.locationMessage) return { locationMessage: tmpl.locationMessage };
    const txt = 'contentText' in tmpl ? tmpl.contentText
        : 'hydratedContentText' in tmpl ? tmpl.hydratedContentText
        : '';
    return { conversation: txt };
}

function extractMessageContent(content) {
    if (!content) return undefined;
    content = normalizeMessageContent(content);
    if (content?.buttonsMessage) {
        return extractFromTemplateContent(content.buttonsMessage);
    }
    if (content?.templateMessage?.hydratedFourRowTemplate) {
        return extractFromTemplateContent(content.templateMessage.hydratedFourRowTemplate);
    }
    if (content?.templateMessage?.hydratedTemplate) {
        return extractFromTemplateContent(content.templateMessage.hydratedTemplate);
    }
    if (content?.templateMessage?.fourRowTemplate) {
        return extractFromTemplateContent(content.templateMessage.fourRowTemplate);
    }
    return content;
}

function buildContextInfo(options) {
    if (!options) return undefined;
    const info = {};

    if (options.quoted) {
        info.stanzaId = options.quoted.key?.id;
        info.participant = options.quoted.key?.participant || options.quoted.key?.remoteJid;
        info.quotedMessage = options.quoted.message;
    }
    if (options.mentions && options.mentions.length) {
        info.mentionedJid = options.mentions;
    }
    if (options.forwardingScore) {
        info.forwardingScore = options.forwardingScore;
        info.isForwarded = true;
    }
    if (options.ephemeralExpiration) {
        info.expiration = options.ephemeralExpiration;
    }
    if (options.disappearingMessagesInChat) {
        info.ephemeralSettingTimestamp = Math.floor(Date.now() / 1000);
        info.expiration = options.disappearingMessagesInChat;
    }
    if (options.messageSecret) {
        info.messageSecret = options.messageSecret;
    }

    if (Object.keys(info).length === 0) return undefined;
    return info;
}

function prepareDisappearingMessageSettingContent(expiration) {
    expiration = expiration || 0;
    return {
        ephemeralMessage: {
            message: {
                protocolMessage: {
                    type: 6,
                    ephemeralExpiration: expiration,
                },
            },
        },
    };
}

function generateForwardMessageContent(msg, forceForward) {
    let content = msg.message;
    if (!content) throw new Error('no content in message');
    content = normalizeMessageContent(content);
    content = deepCopy(content);
    let key = Object.keys(content)[0];
    let score = content?.[key]?.contextInfo?.forwardingScore || 0;
    score += (msg.key.fromMe && !forceForward) ? 0 : 1;
    if (key === 'conversation') {
        content.extendedTextMessage = { text: content[key] };
        delete content.conversation;
        key = 'extendedTextMessage';
    }
    if (score > 0) {
        content[key].contextInfo = { forwardingScore: score, isForwarded: true };
    } else {
        content[key].contextInfo = {};
    }
    return content;
}

async function generateWAMessageContent(content, options) {
    options = options || {};
    let message = {};

    if (typeof content === 'string') {
        content = { text: content };
    }

    const contextInfo = buildContextInfo(options);

    if ('text' in content && content.text !== undefined && content.text !== null) {
        const extContent = { text: content.text };
        let urlInfo = content.linkPreview;
        if (typeof urlInfo === 'undefined' && options.getUrlInfo) {
            urlInfo = await generateLinkPreviewIfRequired(content.text, options.getUrlInfo, options.logger);
        }
        if (urlInfo) {
            extContent.matchedText = urlInfo['matched-text'] || urlInfo.matchedText;
            extContent.jpegThumbnail = urlInfo.jpegThumbnail;
            extContent.description = urlInfo.description;
            extContent.title = urlInfo.title;
            extContent.previewType = 0;
            if (urlInfo.highQualityThumbnail) {
                extContent.thumbnailDirectPath = urlInfo.highQualityThumbnail.directPath;
                extContent.mediaKey = urlInfo.highQualityThumbnail.mediaKey;
                extContent.mediaKeyTimestamp = urlInfo.highQualityThumbnail.mediaKeyTimestamp;
                extContent.thumbnailWidth = urlInfo.highQualityThumbnail.width;
                extContent.thumbnailHeight = urlInfo.highQualityThumbnail.height;
                extContent.thumbnailSha256 = urlInfo.highQualityThumbnail.fileSha256;
                extContent.thumbnailEncSha256 = urlInfo.highQualityThumbnail.fileEncSha256;
            }
            if (urlInfo.thumbnailWidth) extContent.thumbnailWidth = urlInfo.thumbnailWidth;
            if (urlInfo.thumbnailHeight) extContent.thumbnailHeight = urlInfo.thumbnailHeight;
        }
        if (options.backgroundColor) {
            extContent.backgroundArgb = normalizeColor(options.backgroundColor);
        }
        if (options.font) {
            extContent.font = options.font;
        }
        const hasLinkPreview = !!urlInfo;
        const hasStyling = !!options.backgroundColor || !!options.font;
        const hasContextInfo = contextInfo && Object.keys(contextInfo).length > 0;
        if (!hasLinkPreview && !hasStyling && !hasContextInfo) {
            message.conversation = content.text;
        } else {
            if (hasContextInfo) {
                extContent.contextInfo = contextInfo;
            }
            message.extendedTextMessage = extContent;
        }
    } else if ('contacts' in content && content.contacts) {
        const contactList = content.contacts.contacts || [];
        if (contactList.length === 1) {
            message.contactMessage = {
                displayName: contactList[0].displayName,
                vcard: contactList[0].vcard,
                contextInfo,
            };
        } else {
            message.contactsArrayMessage = {
                displayName: content.contacts.displayName || `${contactList.length} contacts`,
                contacts: contactList.map(c => ({
                    displayName: c.displayName,
                    vcard: c.vcard,
                })),
                contextInfo,
            };
        }
    } else if ('location' in content && content.location) {
        message.locationMessage = {
            degreesLatitude: content.location.degreesLatitude,
            degreesLongitude: content.location.degreesLongitude,
            name: content.location.name || '',
            address: content.location.address || '',
            url: content.location.url || '',
            accuracyInMeters: content.location.accuracyInMeters,
            speedInMps: content.location.speedInMps,
            degreesClockwiseFromMagneticNorth: content.location.degreesClockwiseFromMagneticNorth,
            contextInfo,
        };
        if (content.location.jpegThumbnail) {
            message.locationMessage.jpegThumbnail = content.location.jpegThumbnail;
        }
    } else if ('react' in content && content.react) {
        if (!content.react.senderTimestampMs) {
            content.react.senderTimestampMs = Date.now();
        }
        message.reactionMessage = {
            key: content.react.key,
            text: content.react.text,
            senderTimestampMs: content.react.senderTimestampMs,
        };
    } else if ('delete' in content && content.delete) {
        message.protocolMessage = {
            key: content.delete,
            type: 0,
        };
    } else if ('forward' in content && content.forward) {
        message = generateForwardMessageContent(content.forward, content.force);
    } else if ('disappearingMessagesInChat' in content) {
        const exp = typeof content.disappearingMessagesInChat === 'boolean'
            ? (content.disappearingMessagesInChat ? WA_DEFAULT_EPHEMERAL : 0)
            : content.disappearingMessagesInChat;
        message = prepareDisappearingMessageSettingContent(exp);
    } else if ('groupInvite' in content && content.groupInvite) {
        message.groupInviteMessage = {
            groupJid: content.groupInvite.jid || content.groupInvite.groupJid,
            inviteCode: content.groupInvite.inviteCode,
            inviteExpiration: content.groupInvite.inviteExpiration || 0,
            groupName: content.groupInvite.subject || content.groupInvite.groupName || '',
            caption: content.groupInvite.text || content.groupInvite.caption || '',
            contextInfo,
        };
        if (content.groupInvite.jpegThumbnail) {
            message.groupInviteMessage.jpegThumbnail = content.groupInvite.jpegThumbnail;
        }
    } else if ('pin' in content && content.pin) {
        message.pinInChatMessage = {
            key: content.pin,
            type: content.type,
            senderTimestampMs: Date.now(),
        };
        message.messageContextInfo = {
            messageAddOnDurationInSecs: content.type === 1 ? (content.time || 86400) : 0,
        };
    } else if ('buttonReply' in content && content.buttonReply) {
        if (content.type === 'template') {
            message.templateButtonReplyMessage = {
                selectedDisplayText: content.buttonReply.displayText,
                selectedId: content.buttonReply.id,
                selectedIndex: content.buttonReply.index,
            };
        } else {
            message.buttonsResponseMessage = {
                selectedButtonId: content.buttonReply.id,
                selectedDisplayText: content.buttonReply.displayText,
                type: 1,
            };
        }
    } else if ('ptv' in content && content.ptv) {
        const mediaData = await prepareMedia(content.video, 'video', options);
        message.ptvMessage = {
            ...mediaData,
            mimetype: content.mimetype || 'video/mp4',
            contextInfo,
        };
    } else if ('product' in content && content.product) {
        const imgData = content.product.productImage
            ? await prepareMedia(content.product.productImage, 'image', options)
            : undefined;
        message.productMessage = {
            product: {
                ...content.product,
                productImage: imgData ? { ...imgData, mimetype: 'image/jpeg' } : undefined,
            },
        };
    } else if ('listReply' in content && content.listReply) {
        message.listResponseMessage = { ...content.listReply };
    } else if ('event' in content && content.event) {
        const startTimeSec = Math.floor(content.event.startDate.getTime() / 1000);
        message.eventMessage = {
            name: content.event.name,
            description: content.event.description,
            startTime: startTimeSec,
            isCanceled: content.event.isCancelled || false,
            extraGuestsAllowed: content.event.extraGuestsAllowed,
            isScheduleCall: content.event.isScheduleCall || false,
            location: content.event.location,
        };
        if (content.event.endDate) {
            message.eventMessage.endTime = Math.floor(content.event.endDate.getTime() / 1000);
        }
        message.messageContextInfo = {
            messageSecret: content.event.messageSecret || nodeCrypto.randomBytes(32),
        };
    } else if ('poll' in content && content.poll) {
        content.poll.selectableCount = content.poll.selectableCount || 0;
        content.poll.toAnnouncementGroup = content.poll.toAnnouncementGroup || false;
        if (!Array.isArray(content.poll.values)) {
            throw new Error('Invalid poll values');
        }
        if (content.poll.selectableCount < 0 || content.poll.selectableCount > content.poll.values.length) {
            throw new Error(`poll.selectableCount should be >= 0 and <= ${content.poll.values.length}`);
        }
        message.messageContextInfo = {
            messageSecret: content.poll.messageSecret || nodeCrypto.randomBytes(32),
        };
        const pollBody = {
            name: content.poll.name,
            selectableOptionsCount: content.poll.selectableCount,
            options: content.poll.values.map(optionName => ({ optionName })),
        };
        if (content.poll.toAnnouncementGroup) {
            message.pollCreationMessageV2 = pollBody;
        } else if (content.poll.selectableCount === 1) {
            message.pollCreationMessageV3 = pollBody;
        } else {
            message.pollCreationMessage = pollBody;
        }
    } else if ('sharePhoneNumber' in content) {
        message.protocolMessage = { type: 43 };
    } else if ('requestPhoneNumber' in content) {
        message.requestPhoneNumberMessage = {};
    } else if ('limitSharing' in content) {
        message.protocolMessage = {
            type: 44,
            limitSharing: {
                sharingLimited: content.limitSharing === true,
                trigger: 1,
                limitSharingSettingTimestamp: Date.now(),
                initiatedByMe: true,
            },
        };
    } else if ('image' in content || 'video' in content || 'audio' in content
        || 'document' in content || 'sticker' in content) {
        message = await prepareWAMessageMediaContent(content, options, contextInfo);
    } else if ('listMessage' in content && content.listMessage) {
        message.listMessage = {
            title: content.listMessage.title,
            description: content.listMessage.description || '',
            buttonText: content.listMessage.buttonText || 'Select',
            listType: content.listMessage.listType || 1,
            sections: (content.listMessage.sections || []).map(s => ({
                title: s.title,
                rows: (s.rows || []).map(r => ({
                    title: r.title,
                    description: r.description || '',
                    rowId: r.rowId || r.id,
                })),
            })),
            footerText: content.listMessage.footerText || '',
            contextInfo,
        };
    } else if ('buttons' in content && content.buttons) {
        message.buttonsMessage = {
            contentText: content.buttons.text || '',
            footerText: content.buttons.footer || '',
            headerType: content.buttons.headerType || 1,
            buttons: (content.buttons.buttons || []).map((b, i) => ({
                buttonId: b.buttonId || `btn-${i}`,
                buttonText: { displayText: b.displayText || b.text || '' },
                type: b.type || 1,
            })),
            contextInfo,
        };
    } else if ('templateButtons' in content && content.templateButtons) {
        message.templateMessage = {
            hydratedTemplate: {
                hydratedContentText: content.templateButtons.text || '',
                hydratedFooterText: content.templateButtons.footer || '',
                hydratedButtons: (content.templateButtons.buttons || []).map((b, i) => {
                    const btn = {};
                    if (b.urlButton) {
                        btn.urlButton = {
                            displayText: b.urlButton.displayText,
                            url: b.urlButton.url,
                        };
                    }
                    if (b.callButton) {
                        btn.callButton = {
                            displayText: b.callButton.displayText,
                            phoneNumber: b.callButton.phoneNumber,
                        };
                    }
                    if (b.quickReplyButton) {
                        btn.quickReplyButton = {
                            displayText: b.quickReplyButton.displayText,
                            id: b.quickReplyButton.id || `quick-${i}`,
                        };
                    }
                    btn.index = i + 1;
                    return btn;
                }),
            },
            contextInfo,
        };
    } else if ('keepInChat' in content && content.keepInChat) {
        message.keepInChatMessage = {
            key: content.keepInChat.key,
            keepType: content.keepInChat.keep ? 1 : 0,
            timestampMs: BigInt(Date.now()),
        };
    }

    if ('viewOnce' in content && !!content.viewOnce) {
        message = { viewOnceMessage: { message: message } };
    }

    if ('mentions' in content && content.mentions?.length) {
        const msgType = Object.keys(message)[0];
        const innerMsg = message[msgType];
        if (innerMsg && typeof innerMsg === 'object') {
            if (innerMsg.contextInfo) {
                innerMsg.contextInfo.mentionedJid = content.mentions;
            } else {
                innerMsg.contextInfo = { mentionedJid: content.mentions };
            }
        }
    }

    if ('edit' in content && content.edit) {
        message = {
            protocolMessage: {
                key: content.edit,
                editedMessage: message,
                timestampMs: Date.now(),
                type: 14,
            },
        };
    }

    if ('contextInfo' in content && content.contextInfo) {
        const msgType = Object.keys(message)[0];
        const innerMsg = message[msgType];
        if (innerMsg && typeof innerMsg === 'object') {
            if (innerMsg.contextInfo) {
                Object.assign(innerMsg.contextInfo, content.contextInfo);
            } else {
                innerMsg.contextInfo = content.contextInfo;
            }
        }
    }

    return message;
}

async function prepareWAMessageMediaContent(content, options, contextInfo) {
    const message = {};

    if (content.image) {
        const mediaData = await prepareMedia(content.image, 'image', options);
        message.imageMessage = {
            ...mediaData,
            mimetype: content.mimetype || 'image/jpeg',
            caption: content.caption || '',
            width: content.width,
            height: content.height,
            contextInfo,
        };
        if (content.jpegThumbnail) {
            message.imageMessage.jpegThumbnail = content.jpegThumbnail;
        }
        if (content.viewOnce) {
            message.viewOnceMessage = { message: { imageMessage: message.imageMessage } };
            delete message.imageMessage;
        }
    }

    if (content.video) {
        const mediaData = await prepareMedia(content.video, 'video', options);
        message.videoMessage = {
            ...mediaData,
            mimetype: content.mimetype || 'video/mp4',
            caption: content.caption || '',
            seconds: content.seconds || 0,
            gifPlayback: content.gifPlayback || false,
            width: content.width,
            height: content.height,
            contextInfo,
        };
        if (content.jpegThumbnail) {
            message.videoMessage.jpegThumbnail = content.jpegThumbnail;
        }
        if (content.ptv) {
            message.ptvMessage = message.videoMessage;
            delete message.videoMessage;
        }
        if (content.viewOnce) {
            message.viewOnceMessage = { message: { videoMessage: message.videoMessage } };
            delete message.videoMessage;
        }
    }

    if (content.audio) {
        const mediaData = await prepareMedia(content.audio, 'audio', options);
        message.audioMessage = {
            ...mediaData,
            mimetype: content.mimetype || 'audio/ogg; codecs=opus',
            seconds: content.seconds || 0,
            ptt: content.ptt || false,
            contextInfo,
        };
        if (content.waveform) {
            message.audioMessage.waveform = content.waveform;
        }
    }

    if (content.document) {
        const mediaData = await prepareMedia(content.document, 'document', options);
        message.documentMessage = {
            ...mediaData,
            mimetype: content.mimetype || 'application/octet-stream',
            title: content.title || content.fileName || 'document',
            fileName: content.fileName || 'document',
            pageCount: content.pageCount,
            contextInfo,
        };
        if (content.jpegThumbnail) {
            message.documentMessage.jpegThumbnail = content.jpegThumbnail;
        }
        if (content.caption) {
            message.documentMessage.caption = content.caption;
            message.documentWithCaptionMessage = {
                message: { documentMessage: message.documentMessage },
            };
            delete message.documentMessage;
        }
    }

    if (content.sticker) {
        const mediaData = await prepareMedia(content.sticker, 'sticker', options);
        message.stickerMessage = {
            ...mediaData,
            mimetype: content.mimetype || 'image/webp',
            isAnimated: content.isAnimated || false,
            isAvatar: content.isAvatar || false,
            width: content.width || 512,
            height: content.height || 512,
            stickerSentTs: Date.now(),
            contextInfo,
        };
    }

    return message;
}

function normalizeColor(color) {
    if (typeof color === 'number') {
        return color > 0 ? color : 0xffffffff + Number(color) + 1;
    }
    let hex = String(color).trim().replace('#', '');
    if (hex.length <= 6) {
        hex = 'FF' + hex.padStart(6, '0');
    }
    return parseInt(hex, 16);
}

async function prepareMedia(media, mediaType, options) {
    let buffer;
    if (Buffer.isBuffer(media)) {
        buffer = media;
    } else if (typeof media === 'string') {
        if (media.startsWith('data:')) {
            buffer = Buffer.from(media.split(',')[1], 'base64');
        } else if (media.startsWith('http://') || media.startsWith('https://')) {
            const https = require('https');
            const http = require('http');
            const { URL } = require('url');
            const url = new URL(media);
            const mod = url.protocol === 'https:' ? https : http;
            buffer = await new Promise((resolve, reject) => {
                mod.get(url, (res) => {
                    const chunks = [];
                    res.on('data', c => chunks.push(c));
                    res.on('end', () => resolve(Buffer.concat(chunks)));
                    res.on('error', reject);
                }).on('error', reject);
            });
        } else {
            const fs = require('fs');
            buffer = fs.readFileSync(media);
        }
    } else if (media instanceof Uint8Array) {
        buffer = Buffer.from(media);
    } else if (media instanceof require('stream').Readable) {
        const chunks = [];
        for await (const chunk of media) {
            chunks.push(chunk);
        }
        buffer = Buffer.concat(chunks);
    } else {
        throw new Error('Invalid media input: expected Buffer, path, URL, or stream');
    }

    const fileSha256 = nodeCrypto.createHash('sha256').update(buffer).digest();
    const fileLength = buffer.length;

    const result = {
        fileSha256,
        fileLength,
        mediaKeyTimestamp: Math.floor(Date.now() / 1000),
    };

    if (options && options.upload) {
        const uploadResult = await options.upload(buffer, mediaType);
        result.url = uploadResult.url;
        result.directPath = uploadResult.direct_path || uploadResult.directPath;
        result.mediaKey = uploadResult.mediaKey;
        result.fileEncSha256 = uploadResult.fileEncSha256;
    } else {
        result._encBuffer = buffer;
    }

    return result;
}

async function prepareWAMessageMedia(media, options) {
    options = options || {};
    const result = {};

    if (media.image) {
        result.imageMessage = await prepareMedia(media.image, 'image', options);
        result.imageMessage.mimetype = media.mimetype || 'image/jpeg';
    }
    if (media.video) {
        result.videoMessage = await prepareMedia(media.video, 'video', options);
        result.videoMessage.mimetype = media.mimetype || 'video/mp4';
        if (media.ptv) {
            result.ptvMessage = result.videoMessage;
            delete result.videoMessage;
        }
    }
    if (media.audio) {
        result.audioMessage = await prepareMedia(media.audio, 'audio', options);
        result.audioMessage.mimetype = media.mimetype || 'audio/ogg; codecs=opus';
    }
    if (media.document) {
        result.documentMessage = await prepareMedia(media.document, 'document', options);
        result.documentMessage.mimetype = media.mimetype || 'application/octet-stream';
    }
    if (media.sticker) {
        result.stickerMessage = await prepareMedia(media.sticker, 'sticker', options);
        result.stickerMessage.mimetype = media.mimetype || 'image/webp';
        result.stickerMessage.stickerSentTs = Date.now();
    }

    return result;
}

function generateWAMessageFromContent(jid, content, options) {
    options = options || {};
    const proto = loadProto();
    const msgId = options.messageId || generateMessageIDV2(options.userJid);
    const timestamp = options.timestamp
        ? (options.timestamp instanceof Date ? Math.floor(options.timestamp.getTime() / 1000) : options.timestamp)
        : Math.floor(Date.now() / 1000);

    const innerMessage = normalizeMessageContent(content);
    const contentKey = getContentType(innerMessage);
    const { quoted, userJid } = options;

    if (quoted && !isJidNewsletter(jid)) {
        const participant = quoted.key.fromMe
            ? userJid
            : (quoted.participant || quoted.key.participant || quoted.key.remoteJid);
        let quotedMsg = normalizeMessageContent(quoted.message);
        const quotedType = getContentType(quotedMsg);
        if (quotedType && quotedMsg) {
            const strippedQuoted = { [quotedType]: deepCopy(quotedMsg[quotedType]) };
            if (strippedQuoted[quotedType] && typeof strippedQuoted[quotedType] === 'object') {
                delete strippedQuoted[quotedType].contextInfo;
            }
            const existingCtx = (innerMessage && contentKey && innerMessage[contentKey]
                && typeof innerMessage[contentKey] === 'object'
                && innerMessage[contentKey].contextInfo) || {};
            const ctxInfo = {
                ...existingCtx,
                participant: participant ? jidNormalizedUser(participant) : undefined,
                stanzaId: quoted.key.id,
                quotedMessage: strippedQuoted,
            };
            if (jid !== quoted.key.remoteJid) {
                ctxInfo.remoteJid = quoted.key.remoteJid;
            }
            if (innerMessage && contentKey && innerMessage[contentKey] && typeof innerMessage[contentKey] === 'object') {
                innerMessage[contentKey].contextInfo = ctxInfo;
            }
        }
    }

    if (options.ephemeralExpiration && contentKey !== 'protocolMessage'
        && contentKey !== 'ephemeralMessage' && !isJidNewsletter(jid)) {
        if (innerMessage && contentKey && innerMessage[contentKey] && typeof innerMessage[contentKey] === 'object') {
            innerMessage[contentKey].contextInfo = {
                ...(innerMessage[contentKey].contextInfo || {}),
                expiration: options.ephemeralExpiration || WA_DEFAULT_EPHEMERAL,
            };
        }
    }

    let message;
    try {
        message = proto.Message.fromObject(content);
    } catch {
        message = content;
    }

    const key = {
        remoteJid: jid,
        fromMe: true,
        id: msgId,
    };

    const isGroupOrBroadcast = isJidGroup(jid) || isJidStatusBroadcast(jid);
    if (isGroupOrBroadcast && userJid) {
        key.participant = userJid;
    } else if (options.participant) {
        key.participant = options.participant;
    }

    const fullMsg = {
        key,
        message,
        messageTimestamp: timestamp,
        messageStubParameters: [],
        status: 1,
    };
    if (options.userJid) fullMsg.userJid = options.userJid;
    if (options.pushName) fullMsg.pushName = options.pushName;

    return fullMsg;
}

async function generateWAMessage(jid, content, options) {
    options = options || {};
    const msgContent = await generateWAMessageContent(content, { ...options, jid });
    return generateWAMessageFromContent(jid, msgContent, options);
}

function aggregateMessageKeysNotFromMe(keys) {
    const buckets = {};
    for (const { remoteJid, id, participant, fromMe } of keys) {
        if (!fromMe) {
            const compositeKey = `${remoteJid}:${participant || ''}`;
            if (!buckets[compositeKey]) {
                buckets[compositeKey] = { jid: remoteJid, participant: participant, messageIds: [] };
            }
            buckets[compositeKey].messageIds.push(id);
        }
    }
    return Object.values(buckets);
}

function getDevice(id) {
    if (typeof id !== 'string') return 'unknown';
    if (/^3A.{18}$/.test(id)) return 'ios';
    if (/^3E.{20}$/.test(id)) return 'web';
    if (/^(.{21}|.{32})$/.test(id)) return 'android';
    if (/^(3F|.{18}$)/.test(id)) return 'desktop';
    return 'unknown';
}

function getKeyAuthor(key, meId) {
    if (!key) return meId || '';
    if (key.fromMe) return meId || 'me';
    return key.participant || key.remoteJid || '';
}

function updateMessageWithReceipt(msg, receipt) {
    msg.userReceipt = msg.userReceipt || [];
    const existing = msg.userReceipt.find(r =>
        r.userJid === receipt.userJid
    );
    if (existing) {
        Object.assign(existing, receipt);
    } else {
        msg.userReceipt.push(receipt);
    }
}

function updateMessageWithReaction(msg, reaction) {
    const authorID = getKeyAuthor(reaction.key);
    const remaining = (msg.reactions || []).filter(r => getKeyAuthor(r.key) !== authorID);
    reaction.text = reaction.text || '';
    remaining.push(reaction);
    msg.reactions = remaining;
}

function updateMessageWithPollUpdate(msg, update) {
    const authorID = getKeyAuthor(update.pollUpdateMessageKey);
    const remaining = (msg.pollUpdates || []).filter(r => getKeyAuthor(r.pollUpdateMessageKey) !== authorID);
    if (update.vote?.selectedOptions?.length) {
        remaining.push(update);
    }
    msg.pollUpdates = remaining;
}

function updateMessageWithEventResponse(msg, update) {
    const authorID = getKeyAuthor(update.eventResponseMessageKey);
    const remaining = (msg.eventResponses || []).filter(r => getKeyAuthor(r.eventResponseMessageKey) !== authorID);
    remaining.push(update);
    msg.eventResponses = remaining;
}

function getAggregateVotesInPollMessage({ message, pollUpdates }, meId) {
    const opts = message?.pollCreationMessage?.options
        || message?.pollCreationMessageV2?.options
        || message?.pollCreationMessageV3?.options
        || [];
    const voteMap = {};
    for (const opt of opts) {
        const hash = nodeCrypto.createHash('sha256').update(Buffer.from(opt.optionName || '')).digest().toString();
        voteMap[hash] = { name: opt.optionName || '', voters: [] };
    }
    for (const update of pollUpdates || []) {
        if (!update.vote) continue;
        for (const option of update.vote.selectedOptions || []) {
            const hash = option.toString();
            if (!voteMap[hash]) {
                voteMap[hash] = { name: 'Unknown', voters: [] };
            }
            voteMap[hash].voters.push(getKeyAuthor(update.pollUpdateMessageKey, meId));
        }
    }
    return Object.values(voteMap);
}

function getAggregateResponsesInEventMessage({ eventResponses }, meId) {
    const responseTypes = ['GOING', 'NOT_GOING', 'MAYBE'];
    const responseMap = {};
    for (const type of responseTypes) {
        responseMap[type] = { response: type, responders: [] };
    }
    for (const update of eventResponses || []) {
        const responseType = update.eventResponse || 'UNKNOWN';
        if (responseType !== 'UNKNOWN' && responseMap[responseType]) {
            responseMap[responseType].responders.push(getKeyAuthor(update.eventResponseMessageKey, meId));
        }
    }
    return Object.values(responseMap);
}

function deepCopy(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Buffer.isBuffer(obj)) return Buffer.from(obj);
    if (Array.isArray(obj)) return obj.map(deepCopy);
    if (obj instanceof Uint8Array) return new Uint8Array(obj);
    const copy = {};
    for (const key of Object.keys(obj)) {
        copy[key] = deepCopy(obj[key]);
    }
    return copy;
}

module.exports = {
    generateMessageIDV2,
    generateMessageID,
    getContentType,
    extractMessageContent,
    normalizeMessageContent,
    generateWAMessageContent,
    generateWAMessageFromContent,
    generateWAMessage,
    prepareWAMessageMedia,
    buildContextInfo,
    prepareMedia,
    loadProto,
    MESSAGE_TYPE_LIST,
    aggregateMessageKeysNotFromMe,
    getDevice,
    getKeyAuthor,
    updateMessageWithReceipt,
    updateMessageWithReaction,
    updateMessageWithPollUpdate,
    updateMessageWithEventResponse,
    getAggregateVotesInPollMessage,
    getAggregateResponsesInEventMessage,
    deepCopy,
    extractUrlFromText,
    generateLinkPreviewIfRequired,
    generateForwardMessageContent,
    prepareDisappearingMessageSettingContent,
};
