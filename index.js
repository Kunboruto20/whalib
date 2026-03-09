'use strict';

const { makeSocket } = require('./lib/socket');
const { useMultiFileAuthState, initAuthCreds, BufferJSON, makeCacheableSignalKeyStore, addTransactionCapability } = require('./lib/auth-state');
const { Curve, signedKeyPair, generateRegistrationId, generateSignalPubKey } = require('./lib/crypto-utils');
const {
    getPlatformId,
    getBrowserVersion,
    getOSVersion,
    listSupportedBrowsers,
    listSupportedPlatforms,
    OS_VERSIONS,
    BROWSER_VERSIONS,
    PLATFORM_TYPE_MAP,
    PLATFORM_MAP,
    custom: customBrowser
} = require('./lib/wa-browser');
const {
    jidDecode,
    jidEncode,
    jidNormalizedUser,
    isJidGroup,
    isJidBroadcast,
    isJidStatusBroadcast,
    isJidNewsletter,
    isLidUser,
    isPnUser,
    areJidsSameUser,
    S_WHATSAPP_NET,
    WAJIDDomains
} = require('./lib/jid-utils');
const {
    encodeBinaryNode,
    decodeBinaryNode,
    getBinaryNodeChild,
    getBinaryNodeChildren,
    getAllBinaryNodeChildren,
    binaryNodeToString,
    assertNodeErrorFree
} = require('./lib/binary-node');
const {
    WA_WEB_VERSION,
    WA_BROWSER_DESC,
    Browsers,
    NOISE_WA_HEADER,
    KEY_BUNDLE_TYPE
} = require('./lib/constants');
const {
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
    loadProto,
    MESSAGE_TYPE_LIST,
    aggregateMessageKeysNotFromMe,
    getDevice,
    getKeyAuthor: getKeyAuthorMsg,
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
} = require('./lib/messages');
const {
    MEDIA_HKDF_KEY_MAPPING,
    MEDIA_PATH_MAP,
    MEDIA_TYPE_MAP,
    MIMETYPE_MAP,
    hkdfInfoKey,
    getMediaKeys,
    toReadable,
    toBuffer,
    getStream,
    encryptedStream,
    getUrlFromDirectPath,
    downloadContentFromMessage,
    downloadEncryptedContent,
    extensionForMediaMessage,
    getWAUploadToServer,
    mediaMessageSHA256B64,
    encryptMediaRetryRequest,
    decryptMediaRetryData,
    decodeMediaRetryNode,
    downloadMediaMessage,
    assertMediaContent
} = require('./lib/messages-media');
const {
    makeMessagesSocket,
    createSignalIdentity,
    generateOrGetPreKeys,
    getNextPreKeys,
    getNextPreKeysNode,
    xmppSignedPreKey,
    xmppPreKey,
    parseAndInjectE2ESessions,
    extractDeviceJids,
    encodeSignedDeviceIdentity
} = require('./lib/messages-send');
const {
    decodeMessageNode,
    decryptMessageNode,
    processMessage: processMessageRecv,
    cleanMessage: cleanMessageRecv,
    isRealMessage: isRealMessageRecv,
    shouldIncrementChatUnread: shouldIncrementChatUnreadRecv,
    getChatId: getChatIdRecv,
    getKeyAuthor: getKeyAuthorRecv,
    decryptPollVote: decryptPollVoteRecv,
    extractAddressingContext,
    NO_MESSAGE_FOUND_ERROR_TEXT,
    NACK_REASONS
} = require('./lib/messages-recv');
const { createSignalRepository } = require('./lib/signal-repository');
const { makeEventBuffer } = require('./lib/event-buffer');
const { makeGroupsSocket, extractGroupMetadata } = require('./lib/groups');

const {
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
    DISCONNECT_REASON
} = require('./lib/generics');

const { LTHash, LT_HASH_ANTI_TAMPERING } = require('./lib/lt-hash');

const {
    LabelAssociationType,
    mutationKeys,
    newLTHashState,
    encodeSyncdPatch,
    decodeSyncdMutations,
    decodeSyncdPatch,
    extractSyncdPatches,
    downloadExternalBlob,
    downloadExternalPatch,
    decodeSyncdSnapshot,
    decodePatches,
    chatModificationToAppPatch,
    processSyncAction
} = require('./lib/chat-utils');

const {
    downloadHistory,
    processHistoryMessage,
    downloadAndProcessHistorySyncNotification,
    getHistoryMsg
} = require('./lib/history');

const {
    THUMBNAIL_WIDTH_PX,
    getCompressedJpegThumbnail,
    getUrlInfo,
    generateProfilePicture
} = require('./lib/link-preview');

const {
    MessageRetryManager,
    makeMessageRetryHandler,
    RECENT_MESSAGES_SIZE,
    MESSAGE_CACHE_TTL,
    RETRY_COUNTER_TTL,
    RECREATE_SESSION_TIMEOUT,
    PHONE_REQUEST_DELAY
} = require('./lib/message-retry');

const {
    cleanMessage,
    isRealMessage,
    shouldIncrementChatUnread,
    getChatId,
    decryptPollVote,
    decryptEventResponse,
    processMessage,
    handleMessageStub,
    isHostedPnUser,
    isHostedLidUser
} = require('./lib/process-message');

const { LIDMappingStore } = require('./lib/lid-utils');

const { makeChatsSocket, ALL_WA_PATCH_NAMES, MAX_SYNC_ATTEMPTS } = require('./lib/chats');

const {
    parseCatalogNode,
    parseCollectionsNode,
    parseOrderDetailsNode,
    toProductNode,
    parseProductNode,
    uploadingNecessaryImagesOfProduct,
    uploadingNecessaryImages,
    makeBusinessSocket
} = require('./lib/business');

const { makeCommunitiesSocket, extractCommunityMetadata } = require('./lib/communities');

const {
    XWAPaths,
    QueryIds,
    executeWMexQuery,
    makeNewsletterSocket,
    parseNewsletterCreateResponse,
    parseNewsletterMetadata
} = require('./lib/newsletter');

const {
    USyncQuery,
    USyncUser,
    USyncContactProtocol,
    USyncDeviceProtocol,
    USyncStatusProtocol,
    USyncDisappearingModeProtocol,
    USyncLIDProtocol,
    USyncBotProfileProtocol,
    getBinaryNodeChildString,
    executeUSyncQuery
} = require('./lib/usync');

module.exports = {
    default: makeSocket,
    makeSocket,
    useMultiFileAuthState,
    initAuthCreds,
    BufferJSON,
    makeCacheableSignalKeyStore,
    addTransactionCapability,
    Curve,
    signedKeyPair,
    generateRegistrationId,
    generateSignalPubKey,

    jidDecode,
    jidEncode,
    jidNormalizedUser,
    isJidGroup,
    isJidBroadcast,
    isJidStatusBroadcast,
    isJidNewsletter,
    isLidUser,
    isPnUser,
    areJidsSameUser,
    S_WHATSAPP_NET,
    WAJIDDomains,

    encodeBinaryNode,
    decodeBinaryNode,
    getBinaryNodeChild,
    getBinaryNodeChildren,
    getAllBinaryNodeChildren,
    binaryNodeToString,
    assertNodeErrorFree,

    WA_WEB_VERSION,
    WA_BROWSER_DESC,
    Browsers,
    DISCONNECT_REASON,
    NOISE_WA_HEADER,
    KEY_BUNDLE_TYPE,
    getPlatformId,
    getBrowserVersion,
    getOSVersion,
    listSupportedBrowsers,
    listSupportedPlatforms,
    OS_VERSIONS,
    BROWSER_VERSIONS,
    PLATFORM_TYPE_MAP,
    PLATFORM_MAP,
    customBrowser,

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
    loadProto,
    MESSAGE_TYPE_LIST,
    aggregateMessageKeysNotFromMe,
    getDevice,
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

    MEDIA_HKDF_KEY_MAPPING,
    MEDIA_PATH_MAP,
    MEDIA_TYPE_MAP,
    MIMETYPE_MAP,
    hkdfInfoKey,
    getMediaKeys,
    toReadable,
    toBuffer,
    getStream,
    encryptedStream,
    getUrlFromDirectPath,
    downloadContentFromMessage,
    downloadEncryptedContent,
    extensionForMediaMessage,
    getWAUploadToServer,
    mediaMessageSHA256B64,
    encryptMediaRetryRequest,
    decryptMediaRetryData,
    decodeMediaRetryNode,
    downloadMediaMessage,
    assertMediaContent,

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

    decodeMessageNode,
    decryptMessageNode,
    processMessage,
    processMessageRecv,
    cleanMessage,
    cleanMessageRecv,
    isRealMessage,
    isRealMessageRecv,
    shouldIncrementChatUnread,
    shouldIncrementChatUnreadRecv,
    getChatId,
    getChatIdRecv,
    getKeyAuthor: getKeyAuthorRecv,
    decryptPollVote,
    decryptPollVoteRecv,
    decryptEventResponse,
    handleMessageStub,
    isHostedPnUser,
    isHostedLidUser,
    extractAddressingContext,
    NO_MESSAGE_FOUND_ERROR_TEXT,
    NACK_REASONS,

    createSignalRepository,
    makeGroupsSocket,
    extractGroupMetadata,

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

    LTHash,
    LT_HASH_ANTI_TAMPERING,

    LabelAssociationType,
    mutationKeys,
    newLTHashState,
    encodeSyncdPatch,
    decodeSyncdMutations,
    decodeSyncdPatch,
    extractSyncdPatches,
    downloadExternalBlob,
    downloadExternalPatch,
    decodeSyncdSnapshot,
    decodePatches,
    chatModificationToAppPatch,
    processSyncAction,

    downloadHistory,
    processHistoryMessage,
    downloadAndProcessHistorySyncNotification,
    getHistoryMsg,

    THUMBNAIL_WIDTH_PX,
    getCompressedJpegThumbnail,
    getUrlInfo,
    generateProfilePicture,

    MessageRetryManager,
    makeMessageRetryHandler,
    RECENT_MESSAGES_SIZE,
    MESSAGE_CACHE_TTL,
    RETRY_COUNTER_TTL,
    RECREATE_SESSION_TIMEOUT,
    PHONE_REQUEST_DELAY,

    LIDMappingStore,

    makeChatsSocket,
    ALL_WA_PATCH_NAMES,
    MAX_SYNC_ATTEMPTS,

    parseCatalogNode,
    parseCollectionsNode,
    parseOrderDetailsNode,
    toProductNode,
    parseProductNode,
    uploadingNecessaryImagesOfProduct,
    uploadingNecessaryImages,
    makeBusinessSocket,

    makeCommunitiesSocket,
    extractCommunityMetadata,

    XWAPaths,
    QueryIds,
    executeWMexQuery,
    makeNewsletterSocket,
    parseNewsletterCreateResponse,
    parseNewsletterMetadata,

    USyncQuery,
    USyncUser,
    USyncContactProtocol,
    USyncDeviceProtocol,
    USyncStatusProtocol,
    USyncDisappearingModeProtocol,
    USyncLIDProtocol,
    USyncBotProfileProtocol,
    getBinaryNodeChildString,
    executeUSyncQuery,

    makeEventBuffer,
};
