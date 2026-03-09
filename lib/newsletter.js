'use strict';

const { getBinaryNodeChild } = require('./binary-node');
const { S_WHATSAPP_NET } = require('./jid-utils');

const XWAPaths = {
    xwa2_newsletter_create: 'xwa2_newsletter_create',
    xwa2_newsletter_subscribers: 'xwa2_newsletter_subscribers',
    xwa2_newsletter_view: 'xwa2_newsletter_view',
    xwa2_newsletter_metadata: 'xwa2_newsletter',
    xwa2_newsletter_admin_count: 'xwa2_newsletter_admin',
    xwa2_newsletter_mute_v2: 'xwa2_newsletter_mute_v2',
    xwa2_newsletter_unmute_v2: 'xwa2_newsletter_unmute_v2',
    xwa2_newsletter_follow: 'xwa2_newsletter_follow',
    xwa2_newsletter_unfollow: 'xwa2_newsletter_unfollow',
    xwa2_newsletter_change_owner: 'xwa2_newsletter_change_owner',
    xwa2_newsletter_demote: 'xwa2_newsletter_demote',
    xwa2_newsletter_delete_v2: 'xwa2_newsletter_delete_v2',
};

const QueryIds = {
    CREATE: '8823471724422422',
    UPDATE_METADATA: '24250201037901610',
    METADATA: '6563316087068696',
    SUBSCRIBERS: '9783111038412085',
    FOLLOW: '7871414976211147',
    UNFOLLOW: '7238632346214362',
    MUTE: '29766401636284406',
    UNMUTE: '9864994326891137',
    ADMIN_COUNT: '7130823597031706',
    CHANGE_OWNER: '7341777602580933',
    DEMOTE: '6551828931592903',
    DELETE: '30062808666639665',
};

function wMexQuery(variables, queryId, query, generateMessageTag) {
    return query({
        tag: 'iq',
        attrs: {
            id: generateMessageTag(),
            type: 'get',
            to: S_WHATSAPP_NET,
            xmlns: 'w:mex',
        },
        content: [
            {
                tag: 'query',
                attrs: { query_id: queryId },
                content: Buffer.from(JSON.stringify({ variables }), 'utf-8'),
            },
        ],
    });
}

async function executeWMexQuery(variables, queryId, dataPath, query, generateMessageTag) {
    const result = await wMexQuery(variables, queryId, query, generateMessageTag);
    const child = getBinaryNodeChild(result, 'result');
    if (child?.content) {
        const data = JSON.parse(child.content.toString());
        if (data.errors && data.errors.length > 0) {
            const errorMessages = data.errors.map(err => err.message || 'Unknown error').join(', ');
            const firstError = data.errors[0];
            const errorCode = firstError.extensions?.error_code || 400;
            const error = new Error(`GraphQL server error: ${errorMessages}`);
            error.statusCode = errorCode;
            error.data = firstError;
            throw error;
        }
        const response = dataPath ? data?.data?.[dataPath] : data?.data;
        if (typeof response !== 'undefined') {
            return response;
        }
    }
    const action = (dataPath || '').startsWith('xwa2_')
        ? dataPath.substring(5).replace(/_/g, ' ')
        : (dataPath || '').replace(/_/g, ' ');
    const error = new Error(`Failed to ${action}, unexpected response structure.`);
    error.statusCode = 400;
    error.data = result;
    throw error;
}

function parseNewsletterCreateResponse(response) {
    const { id, thread_metadata: thread, viewer_metadata: viewer } = response;
    return {
        id,
        owner: undefined,
        name: thread.name.text,
        creation_time: parseInt(thread.creation_time, 10),
        description: thread.description.text,
        invite: thread.invite,
        subscribers: parseInt(thread.subscribers_count, 10),
        verification: thread.verification,
        picture: {
            id: thread.picture.id,
            directPath: thread.picture.direct_path,
        },
        mute_state: viewer.mute,
    };
}

function parseNewsletterMetadata(result) {
    if (typeof result !== 'object' || result === null) {
        return null;
    }
    if ('id' in result && typeof result.id === 'string') {
        return result;
    }
    if ('result' in result && typeof result.result === 'object' && result.result !== null && 'id' in result.result) {
        return result.result;
    }
    return null;
}

function makeNewsletterSocket({ query, generateMessageTag }) {

    function execWMex(variables, queryId, dataPath) {
        return executeWMexQuery(variables, queryId, dataPath, query, generateMessageTag);
    }

    async function newsletterUpdate(jid, updates) {
        const variables = {
            newsletter_id: jid,
            updates: {
                ...updates,
                settings: null,
            },
        };
        return execWMex(variables, QueryIds.UPDATE_METADATA, 'xwa2_newsletter_update');
    }

    async function newsletterCreate(name, description) {
        const variables = {
            input: {
                name,
                description: description ?? null,
            },
        };
        const rawResponse = await execWMex(variables, QueryIds.CREATE, XWAPaths.xwa2_newsletter_create);
        return parseNewsletterCreateResponse(rawResponse);
    }

    async function newsletterSubscribers(jid) {
        return execWMex({ newsletter_id: jid }, QueryIds.SUBSCRIBERS, XWAPaths.xwa2_newsletter_subscribers);
    }

    async function newsletterMetadata(type, key) {
        const variables = {
            fetch_creation_time: true,
            fetch_full_image: true,
            fetch_viewer_metadata: true,
            input: {
                key,
                type: type.toUpperCase(),
            },
        };
        const result = await execWMex(variables, QueryIds.METADATA, XWAPaths.xwa2_newsletter_metadata);
        return parseNewsletterMetadata(result);
    }

    function newsletterFollow(jid) {
        return execWMex({ newsletter_id: jid }, QueryIds.FOLLOW, XWAPaths.xwa2_newsletter_follow);
    }

    function newsletterUnfollow(jid) {
        return execWMex({ newsletter_id: jid }, QueryIds.UNFOLLOW, XWAPaths.xwa2_newsletter_unfollow);
    }

    function newsletterMute(jid) {
        return execWMex({ newsletter_id: jid }, QueryIds.MUTE, XWAPaths.xwa2_newsletter_mute_v2);
    }

    function newsletterUnmute(jid) {
        return execWMex({ newsletter_id: jid }, QueryIds.UNMUTE, XWAPaths.xwa2_newsletter_unmute_v2);
    }

    async function newsletterUpdateName(jid, name) {
        return newsletterUpdate(jid, { name });
    }

    async function newsletterUpdateDescription(jid, description) {
        return newsletterUpdate(jid, { description });
    }

    async function newsletterUpdatePicture(jid, pictureBase64) {
        return newsletterUpdate(jid, { picture: pictureBase64 });
    }

    async function newsletterRemovePicture(jid) {
        return newsletterUpdate(jid, { picture: '' });
    }

    async function newsletterReactMessage(jid, serverId, reaction) {
        await query({
            tag: 'message',
            attrs: {
                to: jid,
                ...(reaction ? {} : { edit: '7' }),
                type: 'reaction',
                server_id: serverId,
                id: generateMessageTag(),
            },
            content: [
                {
                    tag: 'reaction',
                    attrs: reaction ? { code: reaction } : {},
                },
            ],
        });
    }

    async function newsletterFetchMessages(jid, count, since, after) {
        const messageUpdateAttrs = {
            count: count.toString(),
        };
        if (typeof since === 'number') {
            messageUpdateAttrs.since = since.toString();
        }
        if (after) {
            messageUpdateAttrs.after = after.toString();
        }
        const result = await query({
            tag: 'iq',
            attrs: {
                id: generateMessageTag(),
                type: 'get',
                xmlns: 'newsletter',
                to: jid,
            },
            content: [
                {
                    tag: 'message_updates',
                    attrs: messageUpdateAttrs,
                },
            ],
        });
        return result;
    }

    async function subscribeNewsletterUpdates(jid) {
        const result = await query({
            tag: 'iq',
            attrs: {
                id: generateMessageTag(),
                type: 'set',
                xmlns: 'newsletter',
                to: jid,
            },
            content: [{ tag: 'live_updates', attrs: {}, content: [] }],
        });
        const liveUpdatesNode = getBinaryNodeChild(result, 'live_updates');
        const duration = liveUpdatesNode?.attrs?.duration;
        return duration ? { duration } : null;
    }

    async function newsletterAdminCount(jid) {
        const response = await execWMex({ newsletter_id: jid }, QueryIds.ADMIN_COUNT, XWAPaths.xwa2_newsletter_admin_count);
        return response.admin_count;
    }

    async function newsletterChangeOwner(jid, newOwnerJid) {
        await execWMex({ newsletter_id: jid, user_id: newOwnerJid }, QueryIds.CHANGE_OWNER, XWAPaths.xwa2_newsletter_change_owner);
    }

    async function newsletterDemote(jid, userJid) {
        await execWMex({ newsletter_id: jid, user_id: userJid }, QueryIds.DEMOTE, XWAPaths.xwa2_newsletter_demote);
    }

    async function newsletterDelete(jid) {
        await execWMex({ newsletter_id: jid }, QueryIds.DELETE, XWAPaths.xwa2_newsletter_delete_v2);
    }

    return {
        newsletterCreate,
        newsletterUpdate,
        newsletterSubscribers,
        newsletterMetadata,
        newsletterFollow,
        newsletterUnfollow,
        newsletterMute,
        newsletterUnmute,
        newsletterUpdateName,
        newsletterUpdateDescription,
        newsletterUpdatePicture,
        newsletterRemovePicture,
        newsletterReactMessage,
        newsletterFetchMessages,
        subscribeNewsletterUpdates,
        newsletterAdminCount,
        newsletterChangeOwner,
        newsletterDemote,
        newsletterDelete,
    };
}

module.exports = {
    XWAPaths,
    QueryIds,
    executeWMexQuery,
    makeNewsletterSocket,
    parseNewsletterCreateResponse,
    parseNewsletterMetadata,
};
