'use strict';

const { getHttpStream } = require('./messages-media');
const { prepareWAMessageMedia } = require('./messages');

const THUMBNAIL_WIDTH_PX = 192;

async function getCompressedJpegThumbnail(url, { thumbnailWidth, fetchOpts }) {
    const stream = await getHttpStream(url, fetchOpts);
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return { buffer: Buffer.concat(chunks) };
}

async function getUrlInfo(text, opts = {
    thumbnailWidth: THUMBNAIL_WIDTH_PX,
    fetchOpts: { timeout: 3000 }
}) {
    try {
        let retries = 0;
        const maxRetry = 5;

        const { getLinkPreview } = await import('link-preview-js');

        let previewLink = text;
        if (!text.startsWith('https://') && !text.startsWith('http://')) {
            previewLink = 'https://' + previewLink;
        }

        const info = await getLinkPreview(previewLink, {
            ...opts.fetchOpts,
            followRedirects: 'follow',
            handleRedirects: (baseURL, forwardedURL) => {
                const urlObj = new URL(baseURL);
                const forwardedURLObj = new URL(forwardedURL);
                if (retries >= maxRetry) {
                    return false;
                }
                if (
                    forwardedURLObj.hostname === urlObj.hostname ||
                    forwardedURLObj.hostname === 'www.' + urlObj.hostname ||
                    'www.' + forwardedURLObj.hostname === urlObj.hostname
                ) {
                    retries++;
                    return true;
                }
                return false;
            },
            headers: opts.fetchOpts?.headers
        });

        if (info && 'title' in info && info.title) {
            const [image] = info.images || [];
            const urlInfo = {
                'canonical-url': info.url,
                'matched-text': text,
                title: info.title,
                description: info.description,
                originalThumbnailUrl: image,
            };

            if (opts.uploadImage) {
                const { imageMessage } = await prepareWAMessageMedia(
                    { image: { url: image } },
                    {
                        upload: opts.uploadImage,
                        mediaTypeOverride: 'thumbnail-link',
                        options: opts.fetchOpts,
                    }
                );
                urlInfo.jpegThumbnail = imageMessage?.jpegThumbnail
                    ? Buffer.from(imageMessage.jpegThumbnail)
                    : undefined;
                urlInfo.highQualityThumbnail = imageMessage || undefined;
            } else {
                try {
                    urlInfo.jpegThumbnail = image
                        ? (await getCompressedJpegThumbnail(image, opts)).buffer
                        : undefined;
                } catch (error) {
                    if (opts.logger) {
                        opts.logger.debug(
                            { err: error.stack, url: previewLink },
                            'error in generating thumbnail'
                        );
                    }
                }
            }

            return urlInfo;
        }
    } catch (error) {
        if (!error.message.includes('receive a valid')) {
            throw error;
        }
    }
}

async function generateProfilePicture(mediaUpload, dimensions) {
    const { toBuffer, getStream } = require('./messages-media');
    const { width: w = 640, height: h = 640 } = dimensions || {};

    let buffer;
    if (Buffer.isBuffer(mediaUpload)) {
        buffer = mediaUpload;
    } else if (typeof mediaUpload === 'object' && mediaUpload.url) {
        const { stream } = await getStream(mediaUpload);
        buffer = await toBuffer(stream);
    } else {
        const { stream } = await getStream(mediaUpload);
        buffer = await toBuffer(stream);
    }

    let img;
    try {
        const sharp = require('sharp');
        img = await sharp(buffer)
            .resize(w, h)
            .jpeg({ quality: 50 })
            .toBuffer();
    } catch {
        try {
            const { Jimp } = require('jimp');
            const jimp = await Jimp.read(buffer);
            jimp.resize({ w, h });
            img = await jimp.getBuffer('image/jpeg', { quality: 50 });
        } catch {
            img = buffer;
        }
    }

    return {
        img,
        preview: img,
    };
}

module.exports = {
    THUMBNAIL_WIDTH_PX,
    getCompressedJpegThumbnail,
    getUrlInfo,
    generateProfilePicture,
};
