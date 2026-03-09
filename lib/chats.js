'use strict';

const path = require('path');
const {
    getBinaryNodeChild,
    getBinaryNodeChildren,
    reduceBinaryNodeToDictionary
} = require('./binary-node');
const { jidDecode, jidNormalizedUser, S_WHATSAPP_NET } = require('./jid-utils');
const { makeMutex, toNumber } = require('./generics');
const {
    chatModificationToAppPatch,
    encodeSyncdPatch,
    decodeSyncdSnapshot,
    extractSyncdPatches,
    decodePatches,
    newLTHashState,
    processSyncAction
} = require('./chat-utils');
const { generateProfilePicture } = require('./link-preview');
const { USyncQuery, USyncUser } = require('./usync');

const ALL_WA_PATCH_NAMES = [
    'critical_block',
    'critical_unblock_low',
    'regular_high',
    'regular_low',
    'regular'
];

const MAX_SYNC_ATTEMPTS = 2;

let _proto = null;
function loadProto() {
    if (_proto) return _proto;
    const protobuf = require('protobufjs');
    const root = protobuf.loadSync(path.join(__dirname, '..', 'proto', 'whatsapp.proto'));
    _proto = {
        SyncdPatch: root.lookupType('proto.SyncdPatch'),
    };
    try {
        _proto.HistorySyncNotification = root.lookupType('proto.Message.HistorySyncNotification');
    } catch {}
    return _proto;
}

function makeChatsSocket({ ev, authState, query, sendNode, generateMessageTag, logger, signalRepository, options, getMessage, shouldSyncHistoryMessage, shouldIgnoreJid, markOnlineOnConnect, fireInitQueries, appStateMacVerification, emitOwnEvents, placeholderResendCache }) {
    let privacySettings;
    const processingMutex = makeMutex();

    appStateMacVerification = appStateMacVerification || { snapshot: true, patch: true };

    const getAppStateSyncKey = async (keyId) => {
        const result = await authState.keys.get('app-state-sync-key', [keyId]);
        return result[keyId];
    };

    const fetchPrivacySettings = async (force = false) => {
        if (!privacySettings || force) {
            const result = await query({
                tag: 'iq',
                attrs: {
                    xmlns: 'privacy',
                    to: S_WHATSAPP_NET,
                    type: 'get'
                },
                content: [{ tag: 'privacy', attrs: {} }]
            });
            privacySettings = reduceBinaryNodeToDictionary(result?.content?.[0], 'category');
        }
        return privacySettings;
    };

    const privacyQuery = async (name, value) => {
        await query({
            tag: 'iq',
            attrs: {
                xmlns: 'privacy',
                to: S_WHATSAPP_NET,
                type: 'set'
            },
            content: [
                {
                    tag: 'privacy',
                    attrs: {},
                    content: [
                        {
                            tag: 'category',
                            attrs: { name, value }
                        }
                    ]
                }
            ]
        });
    };

    const updateLastSeenPrivacy = async (value) => {
        await privacyQuery('last', value);
    };

    const updateOnlinePrivacy = async (value) => {
        await privacyQuery('online', value);
    };

    const updateProfilePicturePrivacy = async (value) => {
        await privacyQuery('profile', value);
    };

    const updateStatusPrivacy = async (value) => {
        await privacyQuery('status', value);
    };

    const updateReadReceiptsPrivacy = async (value) => {
        await privacyQuery('readreceipts', value);
    };

    const updateGroupsAddPrivacy = async (value) => {
        await privacyQuery('groupadd', value);
    };

    const updateMessagesPrivacy = async (value) => {
        await privacyQuery('messages', value);
    };

    const updateCallPrivacy = async (value) => {
        await privacyQuery('calladd', value);
    };

    const updateDefaultDisappearingMode = async (duration) => {
        await query({
            tag: 'iq',
            attrs: {
                xmlns: 'disappearing_mode',
                to: S_WHATSAPP_NET,
                type: 'set'
            },
            content: [
                {
                    tag: 'disappearing_mode',
                    attrs: {
                        duration: duration.toString()
                    }
                }
            ]
        });
    };

    const updateProfilePicture = async (jid, content, dimensions) => {
        if (!jid) {
            throw new Error('Please specify either your ID or the ID of the chat you wish to update');
        }
        let targetJid;
        if (jidNormalizedUser(jid) !== jidNormalizedUser(authState.creds.me?.id)) {
            targetJid = jidNormalizedUser(jid);
        }
        const { img } = await generateProfilePicture(content, dimensions);
        await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'w:profile:picture',
                ...(targetJid ? { target: targetJid } : {})
            },
            content: [
                {
                    tag: 'picture',
                    attrs: { type: 'image' },
                    content: img
                }
            ]
        });
    };

    const removeProfilePicture = async (jid) => {
        if (!jid) {
            throw new Error('Please specify either your ID or the ID of the chat you wish to update');
        }
        let targetJid;
        if (jidNormalizedUser(jid) !== jidNormalizedUser(authState.creds.me?.id)) {
            targetJid = jidNormalizedUser(jid);
        }
        await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'w:profile:picture',
                ...(targetJid ? { target: targetJid } : {})
            }
        });
    };

    const updateProfileStatus = async (status) => {
        await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'status'
            },
            content: [
                {
                    tag: 'status',
                    attrs: {},
                    content: Buffer.from(status, 'utf-8')
                }
            ]
        });
    };

    const updateProfileName = async (name) => {
        await chatModify({ pushNameSetting: name }, '');
    };

    const fetchBlocklist = async () => {
        const result = await query({
            tag: 'iq',
            attrs: {
                xmlns: 'blocklist',
                to: S_WHATSAPP_NET,
                type: 'get'
            }
        });
        const listNode = getBinaryNodeChild(result, 'list');
        return getBinaryNodeChildren(listNode, 'item').map(n => n.attrs.jid);
    };

    const updateBlockStatus = async (jid, action) => {
        await query({
            tag: 'iq',
            attrs: {
                xmlns: 'blocklist',
                to: S_WHATSAPP_NET,
                type: 'set'
            },
            content: [
                {
                    tag: 'item',
                    attrs: {
                        action,
                        jid
                    }
                }
            ]
        });
    };

    const getBusinessProfile = async (jid) => {
        const results = await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                xmlns: 'w:biz',
                type: 'get'
            },
            content: [
                {
                    tag: 'business_profile',
                    attrs: { v: '244' },
                    content: [
                        {
                            tag: 'profile',
                            attrs: { jid }
                        }
                    ]
                }
            ]
        });
        const profileNode = getBinaryNodeChild(results, 'business_profile');
        const profiles = getBinaryNodeChild(profileNode, 'profile');
        if (profiles) {
            const address = getBinaryNodeChild(profiles, 'address');
            const description = getBinaryNodeChild(profiles, 'description');
            const website = getBinaryNodeChild(profiles, 'website');
            const email = getBinaryNodeChild(profiles, 'email');
            const category = getBinaryNodeChild(getBinaryNodeChild(profiles, 'categories'), 'category');
            const businessHours = getBinaryNodeChild(profiles, 'business_hours');
            const businessHoursConfig = businessHours
                ? getBinaryNodeChildren(businessHours, 'business_hours_config')
                : undefined;
            const websiteStr = website?.content?.toString();
            return {
                wid: profiles.attrs?.jid,
                address: address?.content?.toString(),
                description: description?.content?.toString() || '',
                website: websiteStr ? [websiteStr] : [],
                email: email?.content?.toString(),
                category: category?.content?.toString(),
                business_hours: {
                    timezone: businessHours?.attrs?.timezone,
                    business_config: businessHoursConfig?.map(({ attrs }) => attrs)
                }
            };
        }
    };

    const fetchStatus = async (...jids) => {
        const usyncQuery = new USyncQuery().withStatusProtocol();
        for (const jid of jids) {
            usyncQuery.withUser(new USyncUser().withId(jid));
        }
        const node = usyncQuery.toQueryNode();
        const result = await query(node);
        const parsed = usyncQuery.parseUSyncQueryResult(result);
        if (parsed) {
            return parsed.list;
        }
    };

    const fetchDisappearingDuration = async (...jids) => {
        const usyncQuery = new USyncQuery().withDisappearingModeProtocol();
        for (const jid of jids) {
            usyncQuery.withUser(new USyncUser().withId(jid));
        }
        const node = usyncQuery.toQueryNode();
        const result = await query(node);
        const parsed = usyncQuery.parseUSyncQueryResult(result);
        if (parsed) {
            return parsed.list;
        }
    };

    const getBotListV2 = async () => {
        const resp = await query({
            tag: 'iq',
            attrs: {
                xmlns: 'bot',
                to: S_WHATSAPP_NET,
                type: 'get'
            },
            content: [
                {
                    tag: 'bot',
                    attrs: { v: '2' }
                }
            ]
        });
        const botNode = getBinaryNodeChild(resp, 'bot');
        const botList = [];
        for (const section of getBinaryNodeChildren(botNode, 'section')) {
            if (section.attrs.type === 'all') {
                for (const bot of getBinaryNodeChildren(section, 'bot')) {
                    botList.push({
                        jid: bot.attrs.jid,
                        personaId: bot.attrs['persona_id']
                    });
                }
            }
        }
        return botList;
    };

    const sendPresenceUpdate = async (type, toJid) => {
        const me = authState.creds.me;
        if (type === 'available' || type === 'unavailable') {
            if (!me?.name) {
                logger?.warn?.('no name present, ignoring presence update request...');
                return;
            }
            ev.emit('connection.update', { isOnline: type === 'available' });
            await sendNode({
                tag: 'presence',
                attrs: {
                    name: me.name.replace(/@/g, ''),
                    type
                }
            });
        } else {
            const decoded = jidDecode(toJid);
            const isLid = decoded?.server === 'lid';
            await sendNode({
                tag: 'chatstate',
                attrs: {
                    from: isLid ? me.lid : me.id,
                    to: toJid
                },
                content: [
                    {
                        tag: type === 'recording' ? 'composing' : type,
                        attrs: type === 'recording' ? { media: 'audio' } : {}
                    }
                ]
            });
        }
    };

    const presenceSubscribe = (toJid, tcToken) => sendNode({
        tag: 'presence',
        attrs: {
            to: toJid,
            id: generateMessageTag(),
            type: 'subscribe'
        },
        content: tcToken
            ? [
                {
                    tag: 'tctoken',
                    attrs: {},
                    content: tcToken
                }
            ]
            : undefined
    });

    const rejectCall = async (callId, callFrom) => {
        await sendNode({
            tag: 'call',
            attrs: {
                from: authState.creds.me?.id,
                to: callFrom
            },
            content: [
                {
                    tag: 'reject',
                    attrs: {
                        'call-id': callId,
                        'call-creator': callFrom,
                        count: '0'
                    }
                }
            ]
        });
    };

    const profilePictureUrl = async (jid, type = 'preview', timeoutMs) => {
        jid = jidNormalizedUser(jid);
        const result = await query({
            tag: 'iq',
            attrs: {
                target: jid,
                to: S_WHATSAPP_NET,
                type: 'get',
                xmlns: 'w:profile:picture'
            },
            content: [{ tag: 'picture', attrs: { type, query: 'url' } }]
        }, timeoutMs);
        const child = getBinaryNodeChild(result, 'picture');
        return child?.attrs?.url;
    };

    const cleanDirtyBits = async (type, fromTimestamp) => {
        logger?.info?.({ fromTimestamp }, 'clean dirty bits ' + type);
        await sendNode({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'urn:xmpp:whatsapp:dirty',
                id: generateMessageTag()
            },
            content: [
                {
                    tag: 'clean',
                    attrs: {
                        type,
                        ...(fromTimestamp ? { timestamp: fromTimestamp.toString() } : {})
                    }
                }
            ]
        });
    };

    const newAppStateChunkHandler = (isInitialSync) => {
        return {
            onMutation(mutation) {
                processSyncAction(mutation, ev, authState.creds.me, isInitialSync ? { accountSettings: authState.creds.accountSettings } : undefined, logger);
            }
        };
    };

    const resyncAppState = async (collections, isInitialSync) => {
        const initialVersionMap = {};
        const globalMutationMap = {};

        const doSync = async () => {
            const collectionsToHandle = new Set(collections);
            const attemptsMap = {};

            while (collectionsToHandle.size) {
                const states = {};
                const nodes = [];
                for (const name of collectionsToHandle) {
                    const result = await authState.keys.get('app-state-sync-version', [name]);
                    let state = result[name];
                    if (state) {
                        if (typeof initialVersionMap[name] === 'undefined') {
                            initialVersionMap[name] = state.version;
                        }
                    } else {
                        state = newLTHashState();
                    }
                    states[name] = state;
                    logger?.info?.(`resyncing ${name} from v${state.version}`);
                    nodes.push({
                        tag: 'collection',
                        attrs: {
                            name,
                            version: state.version.toString(),
                            return_snapshot: (!state.version).toString()
                        }
                    });
                }

                const result = await query({
                    tag: 'iq',
                    attrs: {
                        to: S_WHATSAPP_NET,
                        xmlns: 'w:sync:app:state',
                        type: 'set'
                    },
                    content: [
                        {
                            tag: 'sync',
                            attrs: {},
                            content: nodes
                        }
                    ]
                });

                const decoded = await extractSyncdPatches(result, options);
                for (const key in decoded) {
                    const name = key;
                    const { patches, hasMorePatches, snapshot } = decoded[name];
                    try {
                        if (snapshot) {
                            const { state: newState, mutationMap } = await decodeSyncdSnapshot(
                                name, snapshot, getAppStateSyncKey,
                                initialVersionMap[name],
                                appStateMacVerification.snapshot
                            );
                            states[name] = newState;
                            Object.assign(globalMutationMap, mutationMap);
                            logger?.info?.(`restored state of ${name} from snapshot to v${newState.version} with mutations`);
                            await authState.keys.set({ 'app-state-sync-version': { [name]: newState } });
                        }

                        if (patches.length) {
                            const { state: newState, mutationMap } = await decodePatches(
                                name, patches, states[name], getAppStateSyncKey,
                                options, initialVersionMap[name], logger,
                                appStateMacVerification.patch
                            );
                            await authState.keys.set({ 'app-state-sync-version': { [name]: newState } });
                            logger?.info?.(`synced ${name} to v${newState.version}`);
                            initialVersionMap[name] = newState.version;
                            Object.assign(globalMutationMap, mutationMap);
                        }

                        if (hasMorePatches) {
                            logger?.info?.(`${name} has more patches...`);
                        } else {
                            collectionsToHandle.delete(name);
                        }
                    } catch (error) {
                        const isIrrecoverableError = attemptsMap[name] >= MAX_SYNC_ATTEMPTS ||
                            error.output?.statusCode === 404 ||
                            error.name === 'TypeError';
                        logger?.info?.({ name, error: error.stack }, `failed to sync state from version${isIrrecoverableError ? '' : ', removing and trying from scratch'}`);
                        await authState.keys.set({ 'app-state-sync-version': { [name]: null } });
                        attemptsMap[name] = (attemptsMap[name] || 0) + 1;
                        if (isIrrecoverableError) {
                            collectionsToHandle.delete(name);
                        }
                    }
                }
            }
        };

        if (authState.keys.transaction) {
            await authState.keys.transaction(doSync, authState?.creds?.me?.id || 'resync-app-state');
        } else {
            await doSync();
        }

        const { onMutation } = newAppStateChunkHandler(isInitialSync);
        for (const key in globalMutationMap) {
            onMutation(globalMutationMap[key]);
        }
    };

    const appPatch = async (patchCreate) => {
        const proto = loadProto();
        const name = patchCreate.type;
        const myAppStateKeyId = authState.creds.myAppStateKeyId;
        if (!myAppStateKeyId) {
            throw new Error('App state key not present!');
        }

        let initial;
        let encodeResult;

        const doPatch = async () => {
            logger?.debug?.({ patch: patchCreate }, 'applying app patch');
            await resyncAppState([name], false);
            const result = await authState.keys.get('app-state-sync-version', [name]);
            initial = result[name] || newLTHashState();
            encodeResult = await encodeSyncdPatch(patchCreate, myAppStateKeyId, initial, getAppStateSyncKey);
            const { patch, state } = encodeResult;

            const node = {
                tag: 'iq',
                attrs: {
                    to: S_WHATSAPP_NET,
                    type: 'set',
                    xmlns: 'w:sync:app:state'
                },
                content: [
                    {
                        tag: 'sync',
                        attrs: {},
                        content: [
                            {
                                tag: 'collection',
                                attrs: {
                                    name,
                                    version: (state.version - 1).toString(),
                                    return_snapshot: 'false'
                                },
                                content: [
                                    {
                                        tag: 'patch',
                                        attrs: {},
                                        content: proto.SyncdPatch.encode(proto.SyncdPatch.fromObject(patch)).finish()
                                    }
                                ]
                            }
                        ]
                    }
                ]
            };
            await query(node);
            await authState.keys.set({ 'app-state-sync-version': { [name]: state } });
        };

        await processingMutex.mutex(async () => {
            if (authState.keys.transaction) {
                await authState.keys.transaction(doPatch, authState?.creds?.me?.id || 'app-patch');
            } else {
                await doPatch();
            }
        });

        if (emitOwnEvents) {
            const { onMutation } = newAppStateChunkHandler(false);
            const { mutationMap } = await decodePatches(
                name,
                [{ ...encodeResult.patch, version: { version: encodeResult.state.version } }],
                initial, getAppStateSyncKey, options, undefined, logger
            );
            for (const key in mutationMap) {
                onMutation(mutationMap[key]);
            }
        }
    };

    const chatModify = (mod, jid) => {
        const patch = chatModificationToAppPatch(mod, jid);
        return appPatch(patch);
    };

    const updateDisableLinkPreviewsPrivacy = (isPreviewsDisabled) => {
        return chatModify({ disableLinkPreviews: { isPreviewsDisabled } }, '');
    };

    const star = (jid, messages, starValue) => {
        return chatModify({ star: { messages, star: starValue } }, jid);
    };

    const addOrEditContact = (jid, contact) => {
        return chatModify({ contact }, jid);
    };

    const removeContact = (jid) => {
        return chatModify({ contact: null }, jid);
    };

    const addLabel = (jid, labels) => {
        return chatModify({ addLabel: { ...labels } }, jid);
    };

    const addChatLabel = (jid, labelId) => {
        return chatModify({ addChatLabel: { labelId } }, jid);
    };

    const removeChatLabel = (jid, labelId) => {
        return chatModify({ removeChatLabel: { labelId } }, jid);
    };

    const addMessageLabel = (jid, messageId, labelId) => {
        return chatModify({ addMessageLabel: { messageId, labelId } }, jid);
    };

    const removeMessageLabel = (jid, messageId, labelId) => {
        return chatModify({ removeMessageLabel: { messageId, labelId } }, jid);
    };

    const addOrEditQuickReply = (quickReply) => {
        return chatModify({ quickReply }, '');
    };

    const removeQuickReply = (timestamp) => {
        return chatModify({ quickReply: { timestamp, deleted: true } }, '');
    };

    const fetchProps = async () => {
        const resultNode = await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                xmlns: 'w',
                type: 'get'
            },
            content: [
                {
                    tag: 'props',
                    attrs: {
                        protocol: '2',
                        hash: authState?.creds?.lastPropHash || ''
                    }
                }
            ]
        });
        const propsNode = getBinaryNodeChild(resultNode, 'props');
        let props = {};
        if (propsNode) {
            if (propsNode.attrs?.hash) {
                authState.creds.lastPropHash = propsNode.attrs.hash;
                ev.emit('creds.update', authState.creds);
            }
            props = reduceBinaryNodeToDictionary(propsNode, 'prop');
        }
        logger?.debug?.('fetched props');
        return props;
    };

    const executeInitQueries = async () => {
        await Promise.all([fetchProps(), fetchBlocklist(), fetchPrivacySettings()]);
    };

    const handlePresenceUpdate = ({ tag, attrs, content }) => {
        let presence;
        const jid = attrs.from;
        const participant = attrs.participant || attrs.from;
        if (shouldIgnoreJid && shouldIgnoreJid(jid) && jid !== S_WHATSAPP_NET) {
            return;
        }
        if (tag === 'presence') {
            presence = {
                lastKnownPresence: attrs.type === 'unavailable' ? 'unavailable' : 'available',
                lastSeen: attrs.last && attrs.last !== 'deny' ? +attrs.last : undefined
            };
        } else if (Array.isArray(content)) {
            const [firstChild] = content;
            let type = firstChild.tag;
            if (type === 'paused') {
                type = 'available';
            }
            if (firstChild.attrs?.media === 'audio') {
                type = 'recording';
            }
            presence = { lastKnownPresence: type };
        } else {
            logger?.error?.({ tag, attrs, content }, 'recv invalid presence node');
        }
        if (presence) {
            ev.emit('presence.update', { id: jid, presences: { [participant]: presence } });
        }
    };

    const createCallLink = async (mediaType, scheduledEvent, timeoutMs) => {
        const linkContent = { tag: 'link_create', attrs: { media: mediaType } };
        if (scheduledEvent) {
            linkContent.content = [{
                tag: 'event',
                attrs: { start_time: String(scheduledEvent.startTime) }
            }];
        }
        const result = await query({
            tag: 'call',
            attrs: {
                id: generateMessageTag(),
                to: '@call'
            },
            content: [linkContent]
        }, timeoutMs);
        const linkNode = getBinaryNodeChild(result, 'link_create');
        return linkNode?.attrs?.token;
    };

    const upsertMessage = async (msg, type) => {
        ev.emit('messages.upsert', { messages: [msg], type });
        if (msg.pushName) {
            let contactJid = msg.key.fromMe
                ? authState.creds.me?.id
                : (msg.key.participant || msg.key.remoteJid);
            if (contactJid) {
                contactJid = jidNormalizedUser(contactJid);
                if (!msg.key.fromMe) {
                    ev.emit('contacts.update', [{
                        id: contactJid,
                        notify: msg.pushName,
                        verifiedName: msg.verifiedBizName
                    }]);
                }
                if (msg.key.fromMe && authState.creds.me?.name !== msg.pushName) {
                    ev.emit('creds.update', {
                        me: { ...authState.creds.me, name: msg.pushName }
                    });
                }
            }
        }
    };

    return {
        processingMutex,
        fetchPrivacySettings,
        updateLastSeenPrivacy,
        updateOnlinePrivacy,
        updateProfilePicturePrivacy,
        updateStatusPrivacy,
        updateReadReceiptsPrivacy,
        updateGroupsAddPrivacy,
        updateDefaultDisappearingMode,
        updateMessagesPrivacy,
        updateCallPrivacy,
        updateProfilePicture,
        removeProfilePicture,
        updateProfileStatus,
        updateProfileName,
        fetchBlocklist,
        updateBlockStatus,
        getBusinessProfile,
        fetchStatus,
        fetchDisappearingDuration,
        getBotListV2,
        sendPresenceUpdate,
        presenceSubscribe,
        rejectCall,
        profilePictureUrl,
        cleanDirtyBits,
        newAppStateChunkHandler,
        resyncAppState,
        appPatch,
        chatModify,
        updateDisableLinkPreviewsPrivacy,
        star,
        addOrEditContact,
        removeContact,
        addLabel,
        addChatLabel,
        removeChatLabel,
        addMessageLabel,
        removeMessageLabel,
        addOrEditQuickReply,
        removeQuickReply,
        fetchProps,
        executeInitQueries,
        handlePresenceUpdate,
        createCallLink,
        upsertMessage
    };
}

module.exports = {
    makeChatsSocket,
    ALL_WA_PATCH_NAMES,
    MAX_SYNC_ATTEMPTS
};
