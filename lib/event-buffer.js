'use strict';

const EventEmitter = require('events');
const { trimUndefined } = require('./generics');
const { updateMessageWithReaction, updateMessageWithReceipt } = require('./messages');
const { isRealMessage, shouldIncrementChatUnread } = require('./process-message');

const CONSOLIDATABLE_EVENTS = new Set([
    'messaging-history.set',
    'chats.upsert',
    'chats.update',
    'chats.delete',
    'contacts.upsert',
    'contacts.update',
    'messages.upsert',
    'messages.update',
    'messages.delete',
    'messages.reaction',
    'message-receipt.update',
    'groups.update'
]);

const HISTORY_CACHE_LIMIT = 10000;
const FLUSH_SAFETY_MS = 30000;

function msgKeyStr(key) {
    return `${key.remoteJid},${key.id},${key.fromMe ? '1' : '0'}`;
}

function mergeChats(target, source) {
    if (source.unreadCount === null && target.unreadCount < 0) {
        target.unreadCount = undefined;
        source.unreadCount = undefined;
    }
    if (typeof target.unreadCount === 'number' && typeof source.unreadCount === 'number') {
        source = { ...source };
        if (source.unreadCount >= 0) {
            source.unreadCount = Math.max(source.unreadCount, 0) + Math.max(target.unreadCount, 0);
        }
    }
    return Object.assign(target, source);
}

function freshBufferState() {
    return {
        historySets: {
            chats: {},
            messages: {},
            contacts: {},
            isLatest: false,
            empty: true
        },
        chatUpserts: {},
        chatUpdates: {},
        chatDeletes: new Set(),
        contactUpserts: {},
        contactUpdates: {},
        msgUpserts: {},
        msgUpdates: {},
        msgReactions: {},
        msgDeletes: {},
        msgReceipts: {},
        groupUpdates: {}
    };
}

function collectConsolidated(state) {
    const result = {};

    if (!state.historySets.empty) {
        result['messaging-history.set'] = {
            chats: Object.values(state.historySets.chats),
            messages: Object.values(state.historySets.messages),
            contacts: Object.values(state.historySets.contacts),
            syncType: state.historySets.syncType,
            progress: state.historySets.progress,
            isLatest: state.historySets.isLatest,
            peerDataRequestSessionId: state.historySets.peerDataRequestSessionId
        };
    }

    const upsertedChats = Object.values(state.chatUpserts);
    if (upsertedChats.length) result['chats.upsert'] = upsertedChats;

    const updatedChats = Object.values(state.chatUpdates);
    if (updatedChats.length) result['chats.update'] = updatedChats;

    const deletedChats = Array.from(state.chatDeletes);
    if (deletedChats.length) result['chats.delete'] = deletedChats;

    const upsertedMsgs = Object.values(state.msgUpserts);
    if (upsertedMsgs.length) {
        const upsertType = upsertedMsgs[0].type;
        result['messages.upsert'] = {
            messages: upsertedMsgs.map(entry => entry.message),
            type: upsertType
        };
    }

    const updatedMsgs = Object.values(state.msgUpdates);
    if (updatedMsgs.length) result['messages.update'] = updatedMsgs;

    const deletedMsgs = Object.values(state.msgDeletes);
    if (deletedMsgs.length) result['messages.delete'] = { keys: deletedMsgs };

    const reactionEntries = Object.values(state.msgReactions)
        .flatMap(({ key, reactions }) => reactions.flatMap(reaction => ({ key, reaction })));
    if (reactionEntries.length) result['messages.reaction'] = reactionEntries;

    const receiptEntries = Object.values(state.msgReceipts)
        .flatMap(({ key, userReceipt }) => userReceipt.flatMap(receipt => ({ key, receipt })));
    if (receiptEntries.length) result['message-receipt.update'] = receiptEntries;

    const upsertedContacts = Object.values(state.contactUpserts);
    if (upsertedContacts.length) result['contacts.upsert'] = upsertedContacts;

    const updatedContacts = Object.values(state.contactUpdates);
    if (updatedContacts.length) result['contacts.update'] = updatedContacts;

    const updatedGroups = Object.values(state.groupUpdates);
    if (updatedGroups.length) result['groups.update'] = updatedGroups;

    return result;
}

function ingestEvent(state, cache, eventName, payload, log) {
    switch (eventName) {
        case 'messaging-history.set': {
            for (const chat of payload.chats) {
                const cid = chat.id || '';
                const prior = state.historySets.chats[cid];
                if (prior) {
                    prior.endOfHistoryTransferType = chat.endOfHistoryTransferType;
                }
                if (!prior && !cache.has(cid)) {
                    state.historySets.chats[cid] = chat;
                    cache.add(cid);
                    absorbPendingChatUpdate(state, chat, log);
                }
            }
            for (const contact of payload.contacts) {
                const existing = state.historySets.contacts[contact.id];
                if (existing) {
                    Object.assign(existing, trimUndefined(contact));
                } else {
                    const cacheKey = `c:${contact.id}`;
                    const hasName = contact.notify || contact.name || contact.verifiedName;
                    if (!cache.has(cacheKey) || hasName) {
                        state.historySets.contacts[contact.id] = contact;
                        cache.add(cacheKey);
                    }
                }
            }
            for (const msg of payload.messages) {
                const k = msgKeyStr(msg.key);
                if (!state.historySets.messages[k] && !cache.has(k)) {
                    state.historySets.messages[k] = msg;
                    cache.add(k);
                }
            }
            state.historySets.empty = false;
            state.historySets.syncType = payload.syncType;
            state.historySets.progress = payload.progress;
            state.historySets.peerDataRequestSessionId = payload.peerDataRequestSessionId;
            state.historySets.isLatest = payload.isLatest || state.historySets.isLatest;
            break;
        }
        case 'chats.upsert': {
            for (const chat of payload) {
                const cid = chat.id || '';
                let entry = state.chatUpserts[cid];
                if (cid && !entry) {
                    entry = state.historySets.chats[cid];
                    if (entry) log.debug({ chatId: cid }, 'absorbed chat upsert in chat set');
                }
                if (entry) {
                    entry = mergeChats(entry, chat);
                } else {
                    entry = chat;
                    state.chatUpserts[cid] = entry;
                }
                absorbPendingChatUpdate(state, entry, log);
                if (state.chatDeletes.has(cid)) state.chatDeletes.delete(cid);
            }
            break;
        }
        case 'chats.update': {
            for (const upd of payload) {
                const cid = upd.id;
                const condResult = upd.conditional ? upd.conditional(state) : true;
                if (condResult) {
                    delete upd.conditional;
                    const prior = state.historySets.chats[cid] || state.chatUpserts[cid];
                    if (prior) {
                        mergeChats(prior, upd);
                    } else {
                        const existing = state.chatUpdates[cid] || {};
                        state.chatUpdates[cid] = mergeChats(existing, upd);
                    }
                } else if (condResult === undefined) {
                    state.chatUpdates[cid] = upd;
                }
                if (state.chatDeletes.has(cid)) state.chatDeletes.delete(cid);
            }
            break;
        }
        case 'chats.delete': {
            for (const cid of payload) {
                state.chatDeletes.add(cid);
                delete state.chatUpdates[cid];
                delete state.chatUpserts[cid];
                delete state.historySets.chats[cid];
            }
            break;
        }
        case 'contacts.upsert': {
            for (const contact of payload) {
                let entry = state.contactUpserts[contact.id];
                if (!entry) {
                    entry = state.historySets.contacts[contact.id];
                    if (entry) log.debug({ contactId: contact.id }, 'absorbed contact upsert in contact set');
                }
                if (entry) {
                    entry = Object.assign(entry, trimUndefined(contact));
                } else {
                    entry = contact;
                    state.contactUpserts[contact.id] = entry;
                }
                if (state.contactUpdates[contact.id]) {
                    entry = Object.assign(state.contactUpdates[contact.id], trimUndefined(contact));
                    delete state.contactUpdates[contact.id];
                }
            }
            break;
        }
        case 'contacts.update': {
            for (const upd of payload) {
                const prior = state.historySets.contacts[upd.id] || state.contactUpserts[upd.id];
                if (prior) {
                    Object.assign(prior, upd);
                } else {
                    const existing = state.contactUpdates[upd.id] || {};
                    state.contactUpdates[upd.id] = Object.assign(existing, upd);
                }
            }
            break;
        }
        case 'messages.upsert': {
            const { messages, type } = payload;
            for (const msg of messages) {
                const k = msgKeyStr(msg.key);
                let prior = state.msgUpserts[k]?.message;
                if (!prior) {
                    prior = state.historySets.messages[k];
                    if (prior) log.debug({ messageId: k }, 'absorbed message upsert in message set');
                }
                if (prior) {
                    msg.messageTimestamp = prior.messageTimestamp;
                }
                if (state.msgUpdates[k]) {
                    log.debug('absorbed prior message update in message upsert');
                    Object.assign(msg, state.msgUpdates[k].update);
                    delete state.msgUpdates[k];
                }
                if (state.historySets.messages[k]) {
                    state.historySets.messages[k] = msg;
                } else {
                    state.msgUpserts[k] = {
                        message: msg,
                        type: type === 'notify' || state.msgUpserts[k]?.type === 'notify' ? 'notify' : type
                    };
                }
            }
            break;
        }
        case 'messages.update': {
            for (const { key, update } of payload) {
                const k = msgKeyStr(key);
                const prior = state.historySets.messages[k] || state.msgUpserts[k]?.message;
                if (prior) {
                    Object.assign(prior, update);
                    if (update.status === 4 && !key.fromMe) {
                        adjustUnreadAfterRead(state, prior);
                    }
                } else {
                    const existing = state.msgUpdates[k] || { key, update: {} };
                    Object.assign(existing.update, update);
                    state.msgUpdates[k] = existing;
                }
            }
            break;
        }
        case 'messages.delete': {
            if ('keys' in payload) {
                for (const key of payload.keys) {
                    const k = msgKeyStr(key);
                    state.msgDeletes[k] = key;
                    delete state.msgUpserts[k];
                    delete state.msgUpdates[k];
                }
            }
            break;
        }
        case 'messages.reaction': {
            for (const { key, reaction } of payload) {
                const k = msgKeyStr(key);
                const prior = state.msgUpserts[k];
                if (prior) {
                    updateMessageWithReaction(prior.message, reaction);
                } else {
                    state.msgReactions[k] = state.msgReactions[k] || { key, reactions: [] };
                    updateMessageWithReaction(state.msgReactions[k], reaction);
                }
            }
            break;
        }
        case 'message-receipt.update': {
            for (const { key, receipt } of payload) {
                const k = msgKeyStr(key);
                const prior = state.msgUpserts[k];
                if (prior) {
                    updateMessageWithReceipt(prior.message, receipt);
                } else {
                    state.msgReceipts[k] = state.msgReceipts[k] || { key, userReceipt: [] };
                    updateMessageWithReceipt(state.msgReceipts[k], receipt);
                }
            }
            break;
        }
        case 'groups.update': {
            for (const upd of payload) {
                if (!state.groupUpdates[upd.id]) {
                    state.groupUpdates[upd.id] = Object.assign({}, upd);
                }
            }
            break;
        }
        default:
            throw new Error(`Event "${eventName}" is not consolidatable`);
    }
}

function absorbPendingChatUpdate(state, chat, log) {
    const cid = chat.id || '';
    const pending = state.chatUpdates[cid];
    if (pending) {
        const condResult = pending.conditional ? pending.conditional(state) : true;
        if (condResult) {
            delete pending.conditional;
            log.debug({ chatId: cid }, 'absorbed chat update in existing chat');
            Object.assign(chat, mergeChats(pending, chat));
            delete state.chatUpdates[cid];
        } else if (condResult === false) {
            log.debug({ chatId: cid }, 'chat update condition fail, removing');
            delete state.chatUpdates[cid];
        }
    }
}

function adjustUnreadAfterRead(state, message) {
    const chatId = message.key.remoteJid;
    const chat = state.chatUpdates[chatId] || state.chatUpserts[chatId];
    if (isRealMessage(message) &&
        shouldIncrementChatUnread(message) &&
        typeof chat?.unreadCount === 'number' &&
        chat.unreadCount > 0) {
        chat.unreadCount -= 1;
        if (chat.unreadCount === 0) {
            delete chat.unreadCount;
        }
    }
}

function makeEventBuffer(logger) {
    const ev = new EventEmitter();
    ev.setMaxListeners(100);

    const historyCache = new Set();
    let bufState = freshBufferState();
    let buffering = false;
    let depth = 0;
    let safetyTimer = null;

    ev.on('event', (map) => {
        for (const eventName in map) {
            ev.emit(eventName, map[eventName]);
        }
    });

    function buffer() {
        if (!buffering) {
            logger.debug('Event buffer activated');
            buffering = true;
            depth++;
            if (safetyTimer) clearTimeout(safetyTimer);
            safetyTimer = setTimeout(() => {
                if (buffering) {
                    logger.warn('Buffer timeout reached, auto-flushing');
                    flush();
                }
            }, FLUSH_SAFETY_MS);
        } else {
            depth++;
        }
    }

    function flush() {
        if (!buffering) return false;

        logger.debug({ bufferCount: depth }, 'Flushing event buffer');
        buffering = false;
        depth = 0;

        if (safetyTimer) {
            clearTimeout(safetyTimer);
            safetyTimer = null;
        }

        if (historyCache.size > HISTORY_CACHE_LIMIT) {
            logger.debug({ cacheSize: historyCache.size }, 'Clearing history cache');
            historyCache.clear();
        }

        const nextState = freshBufferState();
        const pendingUpdates = Object.values(bufState.chatUpdates);
        let conditionalRemaining = 0;
        for (const upd of pendingUpdates) {
            if (upd.conditional) {
                conditionalRemaining++;
                nextState.chatUpdates[upd.id] = upd;
                delete bufState.chatUpdates[upd.id];
            }
        }

        const consolidated = collectConsolidated(bufState);
        if (Object.keys(consolidated).length) {
            ev.emit('event', consolidated);
        }
        bufState = nextState;

        logger.trace({ conditionalChatUpdatesLeft: conditionalRemaining }, 'released buffered events');
        return true;
    }

    return {
        process(handler) {
            const wrapper = async (map) => { await handler(map); };
            ev.on('event', wrapper);
            return () => { ev.off('event', wrapper); };
        },

        emit(eventName, payload) {
            if (buffering && CONSOLIDATABLE_EVENTS.has(eventName)) {
                ingestEvent(bufState, historyCache, eventName, payload, logger);
                return true;
            }
            return ev.emit('event', { [eventName]: payload });
        },

        isBuffering() {
            return buffering;
        },

        buffer,
        flush,

        createBufferedFunction(work) {
            return async (...args) => {
                buffer();
                try {
                    const result = await work(...args);
                    if (depth === 1) {
                        setTimeout(() => {
                            if (buffering && depth === 1) flush();
                        }, 100);
                    }
                    return result;
                } catch (err) {
                    throw err;
                } finally {
                    depth = Math.max(0, depth - 1);
                    if (depth === 0) {
                        setTimeout(flush, 100);
                    }
                }
            };
        },

        on: (...args) => ev.on(...args),
        off: (...args) => ev.off(...args),
        removeAllListeners: (...args) => ev.removeAllListeners(...args)
    };
}

module.exports = { makeEventBuffer };
