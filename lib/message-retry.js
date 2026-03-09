'use strict';

const RECENT_MESSAGES_SIZE = 512;
const MESSAGE_KEY_SEPARATOR = '\0';
const RECREATE_SESSION_TIMEOUT = 60 * 60 * 1000;
const PHONE_REQUEST_DELAY = 3000;
const RETRY_COUNTER_TTL = 15 * 60 * 1000;
const MESSAGE_CACHE_TTL = 5 * 60 * 1000;

class SimpleCache {
    constructor(options) {
        this._max = options.max || Infinity;
        this._ttl = options.ttl || 0;
        this._map = new Map();
        this._dispose = options.dispose || null;
        if (options.ttlAutopurge && this._ttl > 0) {
            this._purgeInterval = setInterval(() => this._purge(), Math.min(this._ttl, 60000));
            if (this._purgeInterval.unref) {
                this._purgeInterval.unref();
            }
        }
    }

    set(key, value) {
        if (this._map.has(key)) {
            const old = this._map.get(key);
            if (this._dispose) this._dispose(old.value, key);
            this._map.delete(key);
        }
        this._map.set(key, { value, ts: Date.now() });
        this._evict();
    }

    get(key) {
        const entry = this._map.get(key);
        if (!entry) return undefined;
        if (this._ttl > 0 && Date.now() - entry.ts > this._ttl) {
            this.delete(key);
            return undefined;
        }
        return entry.value;
    }

    has(key) {
        return this.get(key) !== undefined;
    }

    delete(key) {
        const entry = this._map.get(key);
        if (entry) {
            if (this._dispose) this._dispose(entry.value, key);
            this._map.delete(key);
        }
    }

    _evict() {
        while (this._map.size > this._max) {
            const firstKey = this._map.keys().next().value;
            this.delete(firstKey);
        }
    }

    _purge() {
        const now = Date.now();
        for (const [key, entry] of this._map) {
            if (now - entry.ts > this._ttl) {
                this.delete(key);
            }
        }
    }

    destroy() {
        if (this._purgeInterval) {
            clearInterval(this._purgeInterval);
            this._purgeInterval = null;
        }
    }
}

class MessageRetryManager {
    constructor(logger, maxMsgRetryCount) {
        this.logger = logger || { debug() {}, info() {}, warn() {}, error() {} };
        this.maxMsgRetryCount = maxMsgRetryCount || 5;

        this.messageKeyIndex = new Map();

        this.recentMessagesMap = new SimpleCache({
            max: RECENT_MESSAGES_SIZE,
            ttl: MESSAGE_CACHE_TTL,
            ttlAutopurge: true,
            dispose: (_value, key) => {
                const separatorIndex = key.lastIndexOf(MESSAGE_KEY_SEPARATOR);
                if (separatorIndex > -1) {
                    const messageId = key.slice(separatorIndex + MESSAGE_KEY_SEPARATOR.length);
                    this.messageKeyIndex.delete(messageId);
                }
            }
        });

        this.sessionRecreateHistory = new SimpleCache({
            ttl: RECREATE_SESSION_TIMEOUT * 2,
            ttlAutopurge: true
        });

        this.retryCounters = new SimpleCache({
            ttl: RETRY_COUNTER_TTL,
            ttlAutopurge: true
        });

        this.pendingPhoneRequests = {};

        this.statistics = {
            totalRetries: 0,
            successfulRetries: 0,
            failedRetries: 0,
            mediaRetries: 0,
            sessionRecreations: 0,
            phoneRequests: 0
        };
    }

    addRecentMessage(to, id, message) {
        const keyStr = this._keyToString(to, id);
        this.recentMessagesMap.set(keyStr, {
            message,
            timestamp: Date.now()
        });
        this.messageKeyIndex.set(id, keyStr);
        this.logger.debug(`Added message to retry cache: ${to}/${id}`);
    }

    getRecentMessage(to, id) {
        const keyStr = this._keyToString(to, id);
        return this.recentMessagesMap.get(keyStr);
    }

    shouldRecreateSession(jid, retryCount, hasSession) {
        if (!hasSession) {
            this.sessionRecreateHistory.set(jid, Date.now());
            this.statistics.sessionRecreations++;
            return {
                reason: "we don't have a Signal session with them",
                recreate: true
            };
        }

        if (retryCount < 2) {
            return { reason: '', recreate: false };
        }

        const now = Date.now();
        const prevTime = this.sessionRecreateHistory.get(jid);

        if (!prevTime || now - prevTime > RECREATE_SESSION_TIMEOUT) {
            this.sessionRecreateHistory.set(jid, now);
            this.statistics.sessionRecreations++;
            return {
                reason: 'retry count > 1 and over an hour since last recreation',
                recreate: true
            };
        }

        return { reason: '', recreate: false };
    }

    incrementRetryCount(messageId) {
        const current = this.retryCounters.get(messageId) || 0;
        const next = current + 1;
        this.retryCounters.set(messageId, next);
        this.statistics.totalRetries++;
        return next;
    }

    getRetryCount(messageId) {
        return this.retryCounters.get(messageId) || 0;
    }

    hasExceededMaxRetries(messageId) {
        return this.getRetryCount(messageId) >= this.maxMsgRetryCount;
    }

    markRetrySuccess(messageId) {
        this.statistics.successfulRetries++;
        this.retryCounters.delete(messageId);
        this.cancelPendingPhoneRequest(messageId);
        this._removeRecentMessage(messageId);
    }

    markRetryFailed(messageId) {
        this.statistics.failedRetries++;
        this.retryCounters.delete(messageId);
        this.cancelPendingPhoneRequest(messageId);
        this._removeRecentMessage(messageId);
    }

    schedulePhoneRequest(messageId, callback, delay) {
        delay = delay || PHONE_REQUEST_DELAY;
        this.cancelPendingPhoneRequest(messageId);
        this.pendingPhoneRequests[messageId] = setTimeout(() => {
            delete this.pendingPhoneRequests[messageId];
            this.statistics.phoneRequests++;
            callback();
        }, delay);
        this.logger.debug(`Scheduled phone request for message ${messageId} with ${delay}ms delay`);
    }

    cancelPendingPhoneRequest(messageId) {
        const timeout = this.pendingPhoneRequests[messageId];
        if (timeout) {
            clearTimeout(timeout);
            delete this.pendingPhoneRequests[messageId];
            this.logger.debug(`Cancelled pending phone request for message ${messageId}`);
        }
    }

    getStatistics() {
        return { ...this.statistics };
    }

    destroy() {
        for (const id of Object.keys(this.pendingPhoneRequests)) {
            clearTimeout(this.pendingPhoneRequests[id]);
        }
        this.pendingPhoneRequests = {};
        this.recentMessagesMap.destroy();
        this.sessionRecreateHistory.destroy();
        this.retryCounters.destroy();
    }

    _keyToString(to, id) {
        return `${to}${MESSAGE_KEY_SEPARATOR}${id}`;
    }

    _removeRecentMessage(messageId) {
        const keyStr = this.messageKeyIndex.get(messageId);
        if (!keyStr) return;
        this.recentMessagesMap.delete(keyStr);
        this.messageKeyIndex.delete(messageId);
    }
}

function makeMessageRetryHandler(options) {
    options = options || {};
    const logger = options.logger || { debug() {}, info() {}, warn() {}, error() {} };
    const maxRetries = options.maxMsgRetryCount || 5;

    const manager = new MessageRetryManager(logger, maxRetries);

    return {
        addSentMessage(to, id, message) {
            manager.addRecentMessage(to, id, message);
        },

        getSentMessage(to, id) {
            const entry = manager.getRecentMessage(to, id);
            return entry ? entry.message : undefined;
        },

        async onMessageRetryRequest(retryNode, opts) {
            opts = opts || {};
            const { jid, messageId, retryCount } = retryNode;

            if (!jid || !messageId) {
                logger.warn('Invalid retry request: missing jid or messageId');
                return null;
            }

            const count = manager.incrementRetryCount(messageId);
            logger.info(`Retry request #${count} for message ${messageId} from ${jid}`);

            if (manager.hasExceededMaxRetries(messageId)) {
                logger.warn(`Message ${messageId} exceeded max retries (${maxRetries}), giving up`);
                manager.markRetryFailed(messageId);
                return null;
            }

            const hasSession = opts.hasSession !== undefined ? opts.hasSession : true;
            const sessionInfo = manager.shouldRecreateSession(jid, retryCount || count, hasSession);
            if (sessionInfo.recreate) {
                logger.info(`Recreating session for ${jid}: ${sessionInfo.reason}`);
            }

            const cached = manager.getRecentMessage(jid, messageId);
            const message = cached ? cached.message : null;

            return {
                message,
                shouldRecreateSession: sessionInfo.recreate,
                recreateReason: sessionInfo.reason,
                retryCount: count
            };
        },

        schedulePhoneRequest(messageId, callback, delay) {
            manager.schedulePhoneRequest(messageId, callback, delay);
        },

        cancelPhoneRequest(messageId) {
            manager.cancelPendingPhoneRequest(messageId);
        },

        markSuccess(messageId) {
            manager.markRetrySuccess(messageId);
        },

        markFailed(messageId) {
            manager.markRetryFailed(messageId);
        },

        getRetryCount(messageId) {
            return manager.getRetryCount(messageId);
        },

        hasExceededMaxRetries(messageId) {
            return manager.hasExceededMaxRetries(messageId);
        },

        getStatistics() {
            return manager.getStatistics();
        },

        destroy() {
            manager.destroy();
        }
    };
}

module.exports = {
    MessageRetryManager,
    makeMessageRetryHandler,
    RECENT_MESSAGES_SIZE,
    MESSAGE_CACHE_TTL,
    RETRY_COUNTER_TTL,
    RECREATE_SESSION_TIMEOUT,
    PHONE_REQUEST_DELAY
};
