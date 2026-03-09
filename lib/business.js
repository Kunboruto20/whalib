'use strict';

const { createHash } = require('crypto');
const { createWriteStream, promises: fsPromises } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { jidNormalizedUser, S_WHATSAPP_NET } = require('./jid-utils');
const { getBinaryNodeChild, getBinaryNodeChildren } = require('./binary-node');
const { getStream, getUrlFromDirectPath, generateMessageIDV2, getRawMediaUploadData } = require('./messages-media');

function getBinaryNodeChildString(node, tag) {
    const child = getBinaryNodeChild(node, tag);
    if (!child) return undefined;
    if (typeof child.content === 'string') return child.content;
    if (Buffer.isBuffer(child.content)) return child.content.toString('utf-8');
    if (child.content instanceof Uint8Array) return Buffer.from(child.content).toString('utf-8');
    return undefined;
}

function parseCatalogNode(node) {
    const catalogNode = getBinaryNodeChild(node, 'product_catalog');
    const products = getBinaryNodeChildren(catalogNode, 'product').map(parseProductNode);
    const paging = getBinaryNodeChild(catalogNode, 'paging');
    return {
        products,
        nextPageCursor: paging ? getBinaryNodeChildString(paging, 'after') : undefined
    };
}

function parseCollectionsNode(node) {
    const collectionsNode = getBinaryNodeChild(node, 'collections');
    const collections = getBinaryNodeChildren(collectionsNode, 'collection').map(collectionNode => {
        const id = getBinaryNodeChildString(collectionNode, 'id');
        const name = getBinaryNodeChildString(collectionNode, 'name');
        const products = getBinaryNodeChildren(collectionNode, 'product').map(parseProductNode);
        return {
            id,
            name,
            products,
            status: parseStatusInfo(collectionNode)
        };
    });
    return { collections };
}

function parseOrderDetailsNode(node) {
    const orderNode = getBinaryNodeChild(node, 'order');
    const products = getBinaryNodeChildren(orderNode, 'product').map(productNode => {
        const imageNode = getBinaryNodeChild(productNode, 'image');
        return {
            id: getBinaryNodeChildString(productNode, 'id'),
            name: getBinaryNodeChildString(productNode, 'name'),
            imageUrl: getBinaryNodeChildString(imageNode, 'url'),
            price: +getBinaryNodeChildString(productNode, 'price'),
            currency: getBinaryNodeChildString(productNode, 'currency'),
            quantity: +getBinaryNodeChildString(productNode, 'quantity')
        };
    });
    const priceNode = getBinaryNodeChild(orderNode, 'price');
    return {
        price: {
            total: +getBinaryNodeChildString(priceNode, 'total'),
            currency: getBinaryNodeChildString(priceNode, 'currency')
        },
        products
    };
}

function toProductNode(productId, product) {
    const attrs = {};
    const content = [];

    if (typeof productId !== 'undefined') {
        content.push({ tag: 'id', attrs: {}, content: Buffer.from(productId) });
    }
    if (typeof product.name !== 'undefined') {
        content.push({ tag: 'name', attrs: {}, content: Buffer.from(product.name) });
    }
    if (typeof product.description !== 'undefined') {
        content.push({ tag: 'description', attrs: {}, content: Buffer.from(product.description) });
    }
    if (typeof product.retailerId !== 'undefined') {
        content.push({ tag: 'retailer_id', attrs: {}, content: Buffer.from(product.retailerId) });
    }
    if (product.images && product.images.length) {
        content.push({
            tag: 'media',
            attrs: {},
            content: product.images.map(img => {
                if (!('url' in img)) {
                    throw new Error('Expected image for product to already be uploaded');
                }
                return {
                    tag: 'image',
                    attrs: {},
                    content: [
                        { tag: 'url', attrs: {}, content: Buffer.from(img.url.toString()) }
                    ]
                };
            })
        });
    }
    if (typeof product.price !== 'undefined') {
        content.push({ tag: 'price', attrs: {}, content: Buffer.from(product.price.toString()) });
    }
    if (typeof product.currency !== 'undefined') {
        content.push({ tag: 'currency', attrs: {}, content: Buffer.from(product.currency) });
    }
    if ('originCountryCode' in product) {
        if (typeof product.originCountryCode === 'undefined') {
            attrs['compliance_category'] = 'COUNTRY_ORIGIN_EXEMPT';
        } else {
            content.push({
                tag: 'compliance_info',
                attrs: {},
                content: [
                    { tag: 'country_code_origin', attrs: {}, content: Buffer.from(product.originCountryCode) }
                ]
            });
        }
    }
    if (typeof product.isHidden !== 'undefined') {
        attrs['is_hidden'] = product.isHidden.toString();
    }

    return { tag: 'product', attrs, content };
}

function parseProductNode(productNode) {
    const isHidden = productNode.attrs.is_hidden === 'true';
    const id = getBinaryNodeChildString(productNode, 'id');
    const mediaNode = getBinaryNodeChild(productNode, 'media');
    const statusInfoNode = getBinaryNodeChild(productNode, 'status_info');
    return {
        id,
        imageUrls: parseImageUrls(mediaNode),
        reviewStatus: {
            whatsapp: getBinaryNodeChildString(statusInfoNode, 'status')
        },
        availability: 'in stock',
        name: getBinaryNodeChildString(productNode, 'name'),
        retailerId: getBinaryNodeChildString(productNode, 'retailer_id'),
        url: getBinaryNodeChildString(productNode, 'url'),
        description: getBinaryNodeChildString(productNode, 'description'),
        price: +getBinaryNodeChildString(productNode, 'price'),
        currency: getBinaryNodeChildString(productNode, 'currency'),
        isHidden
    };
}

function parseImageUrls(mediaNode) {
    const imgNode = getBinaryNodeChild(mediaNode, 'image');
    return {
        requested: getBinaryNodeChildString(imgNode, 'request_image_url'),
        original: getBinaryNodeChildString(imgNode, 'original_image_url')
    };
}

function parseStatusInfo(mediaNode) {
    const node = getBinaryNodeChild(mediaNode, 'status_info');
    return {
        status: getBinaryNodeChildString(node, 'status'),
        canAppeal: getBinaryNodeChildString(node, 'can_appeal') === 'true'
    };
}

async function uploadingNecessaryImages(images, waUploadToServer, timeoutMs) {
    timeoutMs = timeoutMs || 30000;
    const results = await Promise.all(images.map(async (img) => {
        if ('url' in img) {
            const url = img.url.toString();
            if (url.includes('.whatsapp.net')) {
                return { url };
            }
        }
        const { stream } = await getStream(img);
        const hasher = createHash('sha256');
        const filePath = join(tmpdir(), 'img' + generateMessageIDV2());
        const encFileWriteStream = createWriteStream(filePath);
        for await (const block of stream) {
            hasher.update(block);
            encFileWriteStream.write(block);
        }
        encFileWriteStream.end();
        const sha = hasher.digest('base64');
        const { directPath } = await waUploadToServer(filePath, {
            mediaType: 'product-catalog-image',
            fileEncSha256B64: sha,
            timeoutMs
        });
        await fsPromises.unlink(filePath).catch(() => {});
        return { url: getUrlFromDirectPath(directPath) };
    }));
    return results;
}

async function uploadingNecessaryImagesOfProduct(product, waUploadToServer, timeoutMs) {
    timeoutMs = timeoutMs || 30000;
    return {
        ...product,
        images: product.images
            ? await uploadingNecessaryImages(product.images, waUploadToServer, timeoutMs)
            : product.images
    };
}

function makeBusinessSocket(config, sock) {
    const { authState, query, waUploadToServer } = sock;
    const logger = config.logger;

    const updateBusinessProfile = async (args) => {
        const node = [];
        const simpleFields = ['address', 'email', 'description'];
        node.push(...simpleFields
            .filter(key => args[key])
            .map(key => ({ tag: key, attrs: {}, content: args[key] })));

        if (args.websites) {
            node.push(...args.websites.map(website => ({
                tag: 'website', attrs: {}, content: website
            })));
        }

        if (args.hours) {
            node.push({
                tag: 'business_hours',
                attrs: { timezone: args.hours.timezone },
                content: args.hours.days.map(dayConfig => {
                    const base = {
                        tag: 'business_hours_config',
                        attrs: { day_of_week: dayConfig.day, mode: dayConfig.mode }
                    };
                    if (dayConfig.mode === 'specific_hours') {
                        return {
                            ...base,
                            attrs: {
                                ...base.attrs,
                                open_time: dayConfig.openTimeInMinutes,
                                close_time: dayConfig.closeTimeInMinutes
                            }
                        };
                    }
                    return base;
                })
            });
        }

        return await query({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:biz' },
            content: [{
                tag: 'business_profile',
                attrs: { v: '3', mutation_type: 'delta' },
                content: node
            }]
        });
    };

    const getBusinessProfile = async (jid) => {
        jid = jid || authState.creds.me?.id;
        jid = jidNormalizedUser(jid);
        const result = await query({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'w:biz' },
            content: [{
                tag: 'business_profile',
                attrs: { v: '116' },
                content: [{ tag: 'profile', attrs: { jid } }]
            }]
        });
        const profileNode = getBinaryNodeChild(result, 'business_profile');
        const profile = getBinaryNodeChild(profileNode, 'profile');
        if (!profile) return null;
        const address = getBinaryNodeChildString(profile, 'address');
        const description = getBinaryNodeChildString(profile, 'description');
        const email = getBinaryNodeChildString(profile, 'email');
        const websites = getBinaryNodeChildren(profile, 'website').map(w =>
            typeof w.content === 'string' ? w.content : w.content?.toString?.() || ''
        );
        const category = getBinaryNodeChildString(profile, 'category');
        return { address, description, email, websites, category, jid };
    };

    const updateCoverPhoto = async (photo) => {
        const { fileSha256, filePath } = await getRawMediaUploadData(photo, 'biz-cover-photo');
        const fileSha256B64 = fileSha256.toString('base64');
        const { meta_hmac, fbid, ts } = await waUploadToServer(filePath, {
            fileEncSha256B64: fileSha256B64,
            mediaType: 'biz-cover-photo'
        });
        await query({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:biz' },
            content: [{
                tag: 'business_profile',
                attrs: { v: '3', mutation_type: 'delta' },
                content: [{
                    tag: 'cover_photo',
                    attrs: { id: String(fbid), op: 'update', token: meta_hmac, ts: String(ts) }
                }]
            }]
        });
        return fbid;
    };

    const removeCoverPhoto = async (id) => {
        return await query({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:biz' },
            content: [{
                tag: 'business_profile',
                attrs: { v: '3', mutation_type: 'delta' },
                content: [{
                    tag: 'cover_photo',
                    attrs: { op: 'delete', id }
                }]
            }]
        });
    };

    const getCatalog = async ({ jid, limit, cursor } = {}) => {
        jid = jid || authState.creds.me?.id;
        jid = jidNormalizedUser(jid);
        const queryParamNodes = [
            { tag: 'limit', attrs: {}, content: Buffer.from((limit || 10).toString()) },
            { tag: 'width', attrs: {}, content: Buffer.from('100') },
            { tag: 'height', attrs: {}, content: Buffer.from('100') }
        ];
        if (cursor) {
            queryParamNodes.push({ tag: 'after', attrs: {}, content: cursor });
        }
        const result = await query({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'w:biz:catalog' },
            content: [{
                tag: 'product_catalog',
                attrs: { jid, allow_shop_source: 'true' },
                content: queryParamNodes
            }]
        });
        return parseCatalogNode(result);
    };

    const getCollections = async (jid, limit) => {
        limit = limit || 51;
        jid = jid || authState.creds.me?.id;
        jid = jidNormalizedUser(jid);
        const result = await query({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'w:biz:catalog', smax_id: '35' },
            content: [{
                tag: 'collections',
                attrs: { biz_jid: jid },
                content: [
                    { tag: 'collection_limit', attrs: {}, content: Buffer.from(limit.toString()) },
                    { tag: 'item_limit', attrs: {}, content: Buffer.from(limit.toString()) },
                    { tag: 'width', attrs: {}, content: Buffer.from('100') },
                    { tag: 'height', attrs: {}, content: Buffer.from('100') }
                ]
            }]
        });
        return parseCollectionsNode(result);
    };

    const productCollectionCreate = async (name, productIds) => {
        const result = await query({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:biz:catalog' },
            content: [{
                tag: 'collections',
                attrs: { biz_jid: jidNormalizedUser(authState.creds.me?.id) },
                content: [{
                    tag: 'collection',
                    attrs: {},
                    content: [
                        { tag: 'name', attrs: {}, content: Buffer.from(name) },
                        ...productIds.map(id => ({
                            tag: 'product',
                            attrs: {},
                            content: [{ tag: 'id', attrs: {}, content: Buffer.from(id) }]
                        }))
                    ]
                }]
            }]
        });
        return result;
    };

    const getOrderDetails = async (orderId, tokenBase64) => {
        const result = await query({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'fb:thrift_iq', smax_id: '5' },
            content: [{
                tag: 'order',
                attrs: { op: 'get', id: orderId },
                content: [
                    {
                        tag: 'image_dimensions',
                        attrs: {},
                        content: [
                            { tag: 'width', attrs: {}, content: Buffer.from('100') },
                            { tag: 'height', attrs: {}, content: Buffer.from('100') }
                        ]
                    },
                    { tag: 'token', attrs: {}, content: Buffer.from(tokenBase64) }
                ]
            }]
        });
        return parseOrderDetailsNode(result);
    };

    const productCreate = async (create) => {
        create.isHidden = !!create.isHidden;
        create = await uploadingNecessaryImagesOfProduct(create, waUploadToServer);
        const createNode = toProductNode(undefined, create);
        const result = await query({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:biz:catalog' },
            content: [{
                tag: 'product_catalog_add',
                attrs: { v: '1' },
                content: [
                    createNode,
                    { tag: 'width', attrs: {}, content: '100' },
                    { tag: 'height', attrs: {}, content: '100' }
                ]
            }]
        });
        const productCatalogAddNode = getBinaryNodeChild(result, 'product_catalog_add');
        const productNode = getBinaryNodeChild(productCatalogAddNode, 'product');
        return parseProductNode(productNode);
    };

    const productUpdate = async (productId, update) => {
        update = await uploadingNecessaryImagesOfProduct(update, waUploadToServer);
        const editNode = toProductNode(productId, update);
        const result = await query({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:biz:catalog' },
            content: [{
                tag: 'product_catalog_edit',
                attrs: { v: '1' },
                content: [
                    editNode,
                    { tag: 'width', attrs: {}, content: '100' },
                    { tag: 'height', attrs: {}, content: '100' }
                ]
            }]
        });
        const productCatalogEditNode = getBinaryNodeChild(result, 'product_catalog_edit');
        const productNode = getBinaryNodeChild(productCatalogEditNode, 'product');
        return parseProductNode(productNode);
    };

    const productDelete = async (productIds) => {
        const result = await query({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:biz:catalog' },
            content: [{
                tag: 'product_catalog_delete',
                attrs: { v: '1' },
                content: productIds.map(id => ({
                    tag: 'product',
                    attrs: {},
                    content: [{ tag: 'id', attrs: {}, content: Buffer.from(id) }]
                }))
            }]
        });
        const productCatalogDelNode = getBinaryNodeChild(result, 'product_catalog_delete');
        return {
            deleted: +(productCatalogDelNode?.attrs.deleted_count || 0)
        };
    };

    const getLabels = async () => {
        const result = await query({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'w:biz' },
            content: [{ tag: 'labels', attrs: {} }]
        });
        const labelsNode = getBinaryNodeChild(result, 'labels');
        return getBinaryNodeChildren(labelsNode, 'label').map(labelNode => ({
            id: labelNode.attrs.id,
            name: labelNode.attrs.name,
            predefinedId: labelNode.attrs.predefined_id,
            color: labelNode.attrs.color,
            deleted: labelNode.attrs.deleted === 'true'
        }));
    };

    const createLabel = async (name, color) => {
        const result = await query({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:biz' },
            content: [{
                tag: 'label',
                attrs: { name, color: String(color) },
                content: []
            }]
        });
        return result;
    };

    const updateLabel = async (labelId, name, color) => {
        const attrs = { id: labelId };
        if (name !== undefined) attrs.name = name;
        if (color !== undefined) attrs.color = String(color);
        const result = await query({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:biz' },
            content: [{ tag: 'label', attrs, content: [] }]
        });
        return result;
    };

    const deleteLabel = async (labelId) => {
        const result = await query({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:biz' },
            content: [{
                tag: 'label',
                attrs: { id: labelId, deleted: 'true' },
                content: []
            }]
        });
        return result;
    };

    const labelAssociations = async (labelId, type) => {
        type = type || 'chat';
        const result = await query({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'w:biz' },
            content: [{
                tag: 'label',
                attrs: { id: labelId },
                content: [{ tag: type, attrs: {} }]
            }]
        });
        const labelNode = getBinaryNodeChild(result, 'label');
        const associations = getBinaryNodeChildren(labelNode, type);
        return associations.map(a => ({
            jid: a.attrs.jid,
            messageId: a.attrs.message_id,
            type
        }));
    };

    return {
        updateBusinessProfile,
        getBusinessProfile,
        updateCoverPhoto,
        removeCoverPhoto,
        getCatalog,
        getCollections,
        productCollectionCreate,
        getOrderDetails,
        productCreate,
        productUpdate,
        productDelete,
        getLabels,
        createLabel,
        updateLabel,
        deleteLabel,
        labelAssociations
    };
}

module.exports = {
    parseCatalogNode,
    parseCollectionsNode,
    parseOrderDetailsNode,
    toProductNode,
    parseProductNode,
    uploadingNecessaryImagesOfProduct,
    uploadingNecessaryImages,
    makeBusinessSocket
};
