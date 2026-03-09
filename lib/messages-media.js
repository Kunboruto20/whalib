'use strict';

const nodeCrypto = require('crypto');
const { Readable, Transform } = require('stream');
const { createReadStream, createWriteStream, promises: fsPromises } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { once } = require('events');
const { hkdf, sha256, hmacSign, aesEncryptGCM, aesDecryptGCM } = require('./crypto-utils');

const MEDIA_HKDF_KEY_MAPPING = {
    audio: 'Audio',
    document: 'Document',
    image: 'Image',
    video: 'Video',
    sticker: 'Image',
    'thumbnail-image': 'Image',
    'thumbnail-video': 'Video',
    'thumbnail-link': 'Link Thumbnail',
    'md-msg-hist': 'History',
    'md-app-state': 'App State',
    'product-catalog-image': 'Product Catalog',
    ptv: 'Video',
    'payment-bg-image': 'Payment Background',
};

const MEDIA_PATH_MAP = {
    image: '/mms/image',
    video: '/mms/video',
    document: '/mms/document',
    audio: '/mms/audio',
    sticker: '/mms/image',
    'thumbnail-link': '/mms/image',
    'product-catalog-image': '/mms/image',
    'md-app-state': '',
    'md-msg-hist': '/mms/md-app-state',
    ptv: '/mms/video',
};

const MIMETYPE_MAP = {
    image: 'image/jpeg',
    video: 'video/mp4',
    document: 'application/pdf',
    audio: 'audio/ogg; codecs=opus',
    sticker: 'image/webp',
    'product-catalog-image': 'image/jpeg',
};

const MEDIA_TYPE_MAP = {
    imageMessage: 'image',
    videoMessage: 'video',
    audioMessage: 'audio',
    documentMessage: 'document',
    stickerMessage: 'sticker',
    ptvMessage: 'ptv',
};

const DEF_HOST = 'mmg.whatsapp.net';
const DEFAULT_ORIGIN = 'https://web.whatsapp.com';
const AES_CHUNK_SIZE = 16;

function hkdfInfoKey(type) {
    const hkdfInfo = MEDIA_HKDF_KEY_MAPPING[type];
    if (!hkdfInfo) throw new Error(`Unknown media type: ${type}`);
    return `WhatsApp ${hkdfInfo} Keys`;
}

async function getMediaKeys(buffer, mediaType) {
    if (!buffer) {
        throw new Error('Cannot derive from empty media key');
    }
    if (typeof buffer === 'string') {
        buffer = Buffer.from(buffer.replace('data:;base64,', ''), 'base64');
    }
    const expandedMediaKey = await hkdf(buffer, 112, { info: hkdfInfoKey(mediaType) });
    return {
        iv: expandedMediaKey.slice(0, 16),
        cipherKey: expandedMediaKey.slice(16, 48),
        macKey: expandedMediaKey.slice(48, 80),
    };
}

function toReadable(buffer) {
    const readable = new Readable({ read() {} });
    readable.push(buffer);
    readable.push(null);
    return readable;
}

async function toBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    if (stream.destroy) stream.destroy();
    return Buffer.concat(chunks);
}

async function getStream(item, opts) {
    if (Buffer.isBuffer(item)) {
        return { stream: toReadable(item), type: 'buffer' };
    }
    if (item instanceof Uint8Array) {
        return { stream: toReadable(Buffer.from(item)), type: 'buffer' };
    }
    if (item instanceof Readable) {
        return { stream: item, type: 'readable' };
    }
    if (typeof item === 'object' && item.stream) {
        return { stream: item.stream, type: 'readable' };
    }
    const urlStr = typeof item === 'string' ? item : (item && item.url ? item.url.toString() : '');
    if (urlStr.startsWith('data:')) {
        const buffer = Buffer.from(urlStr.split(',')[1], 'base64');
        return { stream: toReadable(buffer), type: 'buffer' };
    }
    if (urlStr.startsWith('http://') || urlStr.startsWith('https://')) {
        return { stream: await getHttpStream(urlStr, opts), type: 'remote' };
    }
    if (urlStr) {
        return { stream: createReadStream(urlStr), type: 'file' };
    }
    throw new Error('Invalid media source');
}

async function getHttpStream(url, options) {
    options = options || {};
    const urlObj = new (require('url').URL)(url);
    const mod = urlObj.protocol === 'https:' ? require('https') : require('http');

    return new Promise((resolve, reject) => {
        const headers = {
            ...(options.headers || {}),
            Origin: DEFAULT_ORIGIN,
        };
        const reqOptions = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers,
        };
        const req = mod.request(reqOptions, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
                res.resume();
                return;
            }
            resolve(res);
        });
        req.on('error', reject);
        req.end();
    });
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

async function getRawMediaUploadData(media, mediaType, logger) {
    const { stream } = await getStream(media);
    if (logger) logger.debug?.('got stream for raw upload');

    const hasher = nodeCrypto.createHash('sha256');
    const filePath = join(tmpdir(), mediaType + generateMessageIDV2());
    const fileWriteStream = createWriteStream(filePath);
    let fileLength = 0;

    try {
        for await (const data of stream) {
            fileLength += data.length;
            hasher.update(data);
            if (!fileWriteStream.write(data)) {
                await once(fileWriteStream, 'drain');
            }
        }
        fileWriteStream.end();
        await once(fileWriteStream, 'finish');
        if (stream.destroy) stream.destroy();

        const fileSha256 = hasher.digest();
        return { filePath, fileSha256, fileLength };
    } catch (error) {
        fileWriteStream.destroy();
        if (stream.destroy) stream.destroy();
        try { await fsPromises.unlink(filePath); } catch {}
        throw error;
    }
}

async function encryptedStream(media, mediaType, options) {
    options = options || {};
    const { logger, saveOriginalFileIfRequired, opts } = options;

    const { stream, type } = await getStream(media, opts);
    if (logger) logger.debug?.('fetched media stream');

    const mediaKey = nodeCrypto.randomBytes(32);
    const { cipherKey, iv, macKey } = await getMediaKeys(mediaKey, mediaType);

    const encFilePath = join(tmpdir(), mediaType + generateMessageIDV2() + '-enc');
    const encFileWriteStream = createWriteStream(encFilePath);

    let originalFileStream;
    let originalFilePath;
    if (saveOriginalFileIfRequired) {
        originalFilePath = join(tmpdir(), mediaType + generateMessageIDV2() + '-original');
        originalFileStream = createWriteStream(originalFilePath);
    }

    let fileLength = 0;
    const aes = nodeCrypto.createCipheriv('aes-256-cbc', cipherKey, iv);
    const hmacCtx = nodeCrypto.createHmac('sha256', macKey).update(iv);
    const sha256Plain = nodeCrypto.createHash('sha256');
    const sha256Enc = nodeCrypto.createHash('sha256');

    const onChunk = (buff) => {
        sha256Enc.update(buff);
        hmacCtx.update(buff);
        encFileWriteStream.write(buff);
    };

    try {
        for await (const data of stream) {
            fileLength += data.length;
            if (type === 'remote' && opts?.maxContentLength && fileLength > opts.maxContentLength) {
                throw new Error(`content length exceeded when encrypting "${type}"`);
            }
            if (originalFileStream) {
                if (!originalFileStream.write(data)) {
                    await once(originalFileStream, 'drain');
                }
            }
            sha256Plain.update(data);
            onChunk(aes.update(data));
        }
        onChunk(aes.final());

        const mac = hmacCtx.digest().slice(0, 10);
        sha256Enc.update(mac);

        const fileSha256 = sha256Plain.digest();
        const fileEncSha256 = sha256Enc.digest();

        encFileWriteStream.write(mac);
        encFileWriteStream.end();
        if (originalFileStream) originalFileStream.end();
        if (stream.destroy) stream.destroy();

        if (logger) logger.debug?.('encrypted data successfully');

        return {
            mediaKey,
            originalFilePath,
            encFilePath,
            mac,
            fileEncSha256,
            fileSha256,
            fileLength,
        };
    } catch (error) {
        encFileWriteStream.destroy();
        if (originalFileStream) originalFileStream.destroy();
        aes.destroy();
        if (stream.destroy) stream.destroy();
        try {
            await fsPromises.unlink(encFilePath);
            if (originalFilePath) await fsPromises.unlink(originalFilePath);
        } catch {}
        throw error;
    }
}

function getUrlFromDirectPath(directPath) {
    return `https://${DEF_HOST}${directPath}`;
}

async function downloadContentFromMessage({ mediaKey, directPath, url }, type, opts) {
    opts = opts || {};
    const isValidMediaUrl = url?.startsWith('https://mmg.whatsapp.net/');
    const downloadUrl = isValidMediaUrl ? url : getUrlFromDirectPath(directPath);
    if (!downloadUrl) {
        throw new Error('No valid media URL or directPath present in message');
    }
    const keys = await getMediaKeys(mediaKey, type);
    return downloadEncryptedContent(downloadUrl, keys, opts);
}

function toSmallestChunkSize(num) {
    return Math.floor(num / AES_CHUNK_SIZE) * AES_CHUNK_SIZE;
}

async function downloadEncryptedContent(downloadUrl, { cipherKey, iv }, options) {
    options = options || {};
    const { startByte, endByte } = options;

    let bytesFetched = 0;
    let startChunk = 0;
    let firstBlockIsIV = false;

    if (startByte) {
        const chunk = toSmallestChunkSize(startByte || 0);
        if (chunk) {
            startChunk = chunk - AES_CHUNK_SIZE;
            bytesFetched = chunk;
            firstBlockIsIV = true;
        }
    }

    const endChunk = endByte ? toSmallestChunkSize(endByte || 0) + AES_CHUNK_SIZE : undefined;

    const headers = {
        ...(options.headers || {}),
        Origin: DEFAULT_ORIGIN,
    };
    if (startChunk || endChunk) {
        headers.Range = `bytes=${startChunk}-`;
        if (endChunk) headers.Range += endChunk;
    }

    const fetched = await getHttpStream(downloadUrl, { headers });

    let remainingBytes = Buffer.from([]);
    let aes;

    const pushBytes = (bytes, push) => {
        if (startByte || endByte) {
            const start = bytesFetched >= startByte ? undefined : Math.max(startByte - bytesFetched, 0);
            const end = bytesFetched + bytes.length < endByte ? undefined : Math.max(endByte - bytesFetched, 0);
            push(bytes.slice(start, end));
            bytesFetched += bytes.length;
        } else {
            push(bytes);
        }
    };

    const output = new Transform({
        transform(chunk, _, callback) {
            let data = Buffer.concat([remainingBytes, chunk]);
            const decryptLength = toSmallestChunkSize(data.length);
            remainingBytes = data.slice(decryptLength);
            data = data.slice(0, decryptLength);

            if (!aes) {
                let ivValue = iv;
                if (firstBlockIsIV) {
                    ivValue = data.slice(0, AES_CHUNK_SIZE);
                    data = data.slice(AES_CHUNK_SIZE);
                }
                aes = nodeCrypto.createDecipheriv('aes-256-cbc', cipherKey, ivValue);
                if (endByte) {
                    aes.setAutoPadding(false);
                }
            }
            try {
                pushBytes(aes.update(data), b => this.push(b));
                callback();
            } catch (error) {
                callback(error);
            }
        },
        final(callback) {
            try {
                pushBytes(aes.final(), b => this.push(b));
                callback();
            } catch (error) {
                callback(error);
            }
        }
    });

    return fetched.pipe(output, { end: true });
}

function extensionForMediaMessage(message) {
    const getExtension = (mimetype) => mimetype?.split(';')[0]?.split('/')[1];
    const type = Object.keys(message)[0];
    let extension;
    if (type === 'locationMessage' || type === 'liveLocationMessage' || type === 'productMessage') {
        extension = '.jpeg';
    } else {
        const messageContent = message[type];
        extension = getExtension(messageContent?.mimetype);
    }
    return extension;
}

function encodeBase64EncodedStringForUpload(b64) {
    return encodeURIComponent(
        b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    );
}

function getWAUploadToServer(config, refreshMediaConn) {
    const customUploadHosts = config.customUploadHosts || [];
    const logger = config.logger;

    return async function waUploadToServer(filePath, { mediaType, fileEncSha256B64, timeoutMs }) {
        let uploadInfo = await refreshMediaConn(false);
        let urls;
        const hosts = [...customUploadHosts, ...uploadInfo.hosts];
        fileEncSha256B64 = encodeBase64EncodedStringForUpload(fileEncSha256B64);

        for (const { hostname } of hosts) {
            if (logger) logger.debug?.(`uploading to "${hostname}"`);
            const auth = encodeURIComponent(uploadInfo.auth);
            const mediaPath = MEDIA_PATH_MAP[mediaType] || '/mms/image';
            const url = `https://${hostname}${mediaPath}/${fileEncSha256B64}?auth=${auth}&token=${fileEncSha256B64}`;

            let result;
            try {
                const stream = createReadStream(filePath);
                const bodyChunks = [];
                for await (const chunk of stream) {
                    bodyChunks.push(chunk);
                }
                const body = Buffer.concat(bodyChunks);

                const https = require('https');
                const urlObj = new (require('url').URL)(url);

                result = await new Promise((resolve, reject) => {
                    const reqOptions = {
                        hostname: urlObj.hostname,
                        path: urlObj.pathname + urlObj.search,
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/octet-stream',
                            'Content-Length': body.length,
                            Origin: DEFAULT_ORIGIN,
                        },
                        timeout: timeoutMs || 60000,
                    };

                    const req = https.request(reqOptions, (res) => {
                        const chunks = [];
                        res.on('data', c => chunks.push(c));
                        res.on('end', () => {
                            const responseBody = Buffer.concat(chunks).toString();
                            try {
                                resolve(JSON.parse(responseBody));
                            } catch {
                                resolve({ rawBody: responseBody, statusCode: res.statusCode });
                            }
                        });
                        res.on('error', reject);
                    });
                    req.on('error', reject);
                    req.on('timeout', () => {
                        req.destroy();
                        reject(new Error('Upload timeout'));
                    });
                    req.write(body);
                    req.end();
                });

                if (result?.url || result?.directPath || result?.direct_path) {
                    urls = {
                        mediaUrl: result.url,
                        directPath: result.direct_path || result.directPath,
                    };
                    break;
                } else {
                    uploadInfo = await refreshMediaConn(true);
                    throw new Error(`upload failed, reason: ${JSON.stringify(result)}`);
                }
            } catch (error) {
                const isLast = hostname === hosts[hosts.length - 1]?.hostname;
                if (logger) logger.warn?.({ trace: error?.stack, uploadResult: result }, `Error in uploading to ${hostname} ${isLast ? '' : ', retrying...'}`);
            }
        }

        if (!urls) {
            throw new Error('Media upload failed on all hosts');
        }
        return urls;
    };
}

function mediaMessageSHA256B64(message) {
    const media = Object.values(message)[0];
    return media?.fileSha256 && Buffer.from(media.fileSha256).toString('base64');
}

async function getMediaRetryKey(mediaKey) {
    return hkdf(mediaKey, 32, { info: 'WhatsApp Media Retry Notification' });
}

async function encryptMediaRetryRequest(key, mediaKey, meId) {
    const protobuf = require('protobufjs');
    const path = require('path');
    const root = protobuf.loadSync(path.join(__dirname, '..', 'proto', 'whatsapp.proto'));

    const ServerErrorReceipt = root.lookupType('proto.ServerErrorReceipt');
    const recp = { stanzaId: key.id };
    const recpBuffer = ServerErrorReceipt ? ServerErrorReceipt.encode(ServerErrorReceipt.fromObject(recp)).finish() : Buffer.from(key.id);
    const iv = nodeCrypto.randomBytes(12);
    const retryKey = await getMediaRetryKey(mediaKey);
    const ciphertext = aesEncryptGCM(recpBuffer, retryKey, iv, Buffer.from(key.id));
    const { jidNormalizedUser } = require('./jid-utils');

    return {
        tag: 'receipt',
        attrs: {
            id: key.id,
            to: jidNormalizedUser(meId),
            type: 'server-error',
        },
        content: [
            {
                tag: 'encrypt',
                attrs: {},
                content: [
                    { tag: 'enc_p', attrs: {}, content: ciphertext },
                    { tag: 'enc_iv', attrs: {}, content: iv },
                ],
            },
            {
                tag: 'rmr',
                attrs: {
                    jid: key.remoteJid,
                    from_me: (!!key.fromMe).toString(),
                    ...(key.participant ? { participant: key.participant } : {}),
                },
            },
        ],
    };
}

async function decryptMediaRetryData({ ciphertext, iv }, mediaKey, msgId) {
    const retryKey = await getMediaRetryKey(mediaKey);
    const plaintext = aesDecryptGCM(ciphertext, retryKey, iv, Buffer.from(msgId));

    const protobuf = require('protobufjs');
    const path = require('path');
    const root = protobuf.loadSync(path.join(__dirname, '..', 'proto', 'whatsapp.proto'));
    const MediaRetryNotification = root.lookupType('proto.MediaRetryNotification');
    return MediaRetryNotification.decode(plaintext);
}

function decodeMediaRetryNode(node) {
    const { getBinaryNodeChild, getBinaryNodeChildBuffer } = require('./binary-node');
    const rmrNode = getBinaryNodeChild(node, 'rmr');
    const event = {
        key: {
            id: node.attrs.id,
            remoteJid: rmrNode?.attrs?.jid,
            fromMe: rmrNode?.attrs?.from_me === 'true',
            participant: rmrNode?.attrs?.participant,
        },
    };

    const errorNode = getBinaryNodeChild(node, 'error');
    if (errorNode) {
        const errorCode = +(errorNode.attrs?.code || 0);
        event.error = new Error(`Failed to re-upload media (${errorCode})`);
        event.error.statusCode = getStatusCodeForMediaRetry(errorCode);
    } else {
        const encryptedInfoNode = getBinaryNodeChild(node, 'encrypt');
        const ciphertext = getBinaryNodeChildBuffer(encryptedInfoNode, 'enc_p');
        const iv = getBinaryNodeChildBuffer(encryptedInfoNode, 'enc_iv');
        if (ciphertext && iv) {
            event.media = { ciphertext, iv };
        } else {
            event.error = new Error('Failed to re-upload media (missing ciphertext)');
            event.error.statusCode = 404;
        }
    }
    return event;
}

const MEDIA_RETRY_STATUS_MAP = {
    0: 200,
    1: 412,
    2: 404,
    3: 418,
};

function getStatusCodeForMediaRetry(code) {
    return MEDIA_RETRY_STATUS_MAP[code];
}

async function downloadMediaMessage(message, type, options, ctx) {
    const downloadMsg = async () => {
        const { extractMessageContent, getContentType } = require('./messages');
        const mContent = extractMessageContent(message.message);
        if (!mContent) {
            throw new Error('No message present');
        }
        const contentType = getContentType(mContent);
        let mediaType = contentType?.replace('Message', '');
        const media = mContent[contentType];
        if (!media || typeof media !== 'object' || (!('url' in media) && !('thumbnailDirectPath' in media))) {
            throw new Error(`"${contentType}" message is not a media message`);
        }

        let download;
        if ('thumbnailDirectPath' in media && !('url' in media)) {
            download = {
                directPath: media.thumbnailDirectPath,
                mediaKey: media.mediaKey,
            };
            mediaType = 'thumbnail-link';
        } else {
            download = media;
        }

        const stream = await downloadContentFromMessage(download, mediaType, options);
        if (type === 'buffer') {
            return toBuffer(stream);
        }
        return stream;
    };

    const REUPLOAD_REQUIRED_STATUS = [410, 404];
    try {
        return await downloadMsg();
    } catch (error) {
        if (ctx && typeof error?.statusCode === 'number' && REUPLOAD_REQUIRED_STATUS.includes(error.statusCode)) {
            if (ctx.logger) ctx.logger.info?.({ key: message.key }, 'sending reupload media request...');
            message = await ctx.reuploadRequest(message);
            return downloadMsg();
        }
        throw error;
    }
}

function assertMediaContent(content) {
    const { extractMessageContent } = require('./messages');
    content = extractMessageContent(content);
    const mediaContent = content?.documentMessage
        || content?.imageMessage
        || content?.videoMessage
        || content?.audioMessage
        || content?.stickerMessage;
    if (!mediaContent) {
        throw new Error('given message is not a media message');
    }
    return mediaContent;
}

module.exports = {
    MEDIA_HKDF_KEY_MAPPING,
    MEDIA_PATH_MAP,
    MEDIA_TYPE_MAP,
    MIMETYPE_MAP,
    DEF_HOST,
    DEFAULT_ORIGIN,
    hkdfInfoKey,
    getMediaKeys,
    toReadable,
    toBuffer,
    getStream,
    getHttpStream,
    getRawMediaUploadData,
    encryptedStream,
    getUrlFromDirectPath,
    downloadContentFromMessage,
    downloadEncryptedContent,
    extensionForMediaMessage,
    encodeBase64EncodedStringForUpload,
    getWAUploadToServer,
    mediaMessageSHA256B64,
    encryptMediaRetryRequest,
    decryptMediaRetryData,
    decodeMediaRetryNode,
    getStatusCodeForMediaRetry,
    downloadMediaMessage,
    assertMediaContent,
    generateMessageIDV2,
};
