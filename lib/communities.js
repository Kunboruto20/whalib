'use strict';

const {
    getBinaryNodeChild,
    getBinaryNodeChildren,
    getBinaryNodeChildBuffer
} = require('./binary-node');
const { jidEncode, jidNormalizedUser } = require('./jid-utils');
const { unixTimestampSeconds } = require('./generics');
const { generateMessageIDV2 } = require('./messages-media');

function extractCommunityMetadata(result) {
    const community = getBinaryNodeChild(result, 'community') || result;
    const attrs = community.attrs || {};

    const descChild = getBinaryNodeChild(community, 'description');
    const descId = descChild?.attrs?.id;
    const descBody = getBinaryNodeChild(descChild, 'body');
    const desc = descBody?.content
        ? (Buffer.isBuffer(descBody.content) ? descBody.content.toString('utf-8') : String(descBody.content))
        : undefined;

    const participants = getBinaryNodeChildren(community, 'participant');
    const ephChild = getBinaryNodeChild(community, 'ephemeral');
    const memberAddModeChild = getBinaryNodeChild(community, 'member_add_mode');
    const memberAddModeVal = memberAddModeChild?.content
        ? (Buffer.isBuffer(memberAddModeChild.content) ? memberAddModeChild.content.toString('utf-8') : String(memberAddModeChild.content))
        : undefined;
    const linkedParentChild = getBinaryNodeChild(community, 'linked_parent');
    const addressingModeChild = getBinaryNodeChild(community, 'addressing_mode');
    const addressingMode = addressingModeChild?.content
        ? (Buffer.isBuffer(addressingModeChild.content) ? addressingModeChild.content.toString('utf-8') : String(addressingModeChild.content))
        : undefined;

    const communityId = attrs.id?.includes('@')
        ? attrs.id
        : jidEncode(attrs.id || '', 'g.us');

    return {
        id: communityId,
        subject: attrs.subject || '',
        subjectOwner: attrs.s_o,
        subjectTime: attrs.s_t ? +attrs.s_t : undefined,
        size: participants.length,
        creation: attrs.creation ? +attrs.creation : undefined,
        owner: attrs.creator ? jidNormalizedUser(attrs.creator) : undefined,
        desc,
        descId,
        linkedParent: linkedParentChild?.attrs?.jid || undefined,
        restrict: !!getBinaryNodeChild(community, 'locked'),
        announce: !!getBinaryNodeChild(community, 'announcement'),
        isCommunity: !!getBinaryNodeChild(community, 'parent'),
        isCommunityAnnounce: !!getBinaryNodeChild(community, 'default_sub_community'),
        joinApprovalMode: !!getBinaryNodeChild(community, 'membership_approval_mode'),
        memberAddMode: memberAddModeVal === 'all_member_add',
        participants: participants.map(p => ({
            id: p.attrs?.jid,
            admin: p.attrs?.type || null,
            isAdmin: p.attrs?.type === 'admin' || p.attrs?.type === 'superadmin',
            isSuperAdmin: p.attrs?.type === 'superadmin'
        })),
        ephemeralDuration: ephChild?.attrs?.expiration ? +ephChild.attrs.expiration : undefined,
        addressingMode
    };
}

function makeCommunitiesSocket({ query, generateMessageTag, groupMetadata, ev, authState, upsertMessage }) {

    async function communityQuery(jid, type, content) {
        return query({
            tag: 'iq',
            attrs: {
                id: generateMessageTag(),
                type,
                xmlns: 'w:g2',
                to: jid
            },
            content
        });
    }

    async function communityMetadata(jid) {
        const result = await communityQuery(jid, 'get', [
            { tag: 'query', attrs: { request: 'interactive' } }
        ]);
        return extractCommunityMetadata(result);
    }

    async function communityCreate(subject, body) {
        const descriptionId = generateMessageTag().substring(0, 12);
        const result = await communityQuery('@g.us', 'set', [
            {
                tag: 'create',
                attrs: { subject },
                content: [
                    {
                        tag: 'description',
                        attrs: { id: descriptionId },
                        content: [
                            {
                                tag: 'body',
                                attrs: {},
                                content: Buffer.from(body || '', 'utf-8')
                            }
                        ]
                    },
                    {
                        tag: 'parent',
                        attrs: { default_membership_approval_mode: 'request_required' }
                    },
                    {
                        tag: 'allow_non_admin_sub_group_creation',
                        attrs: {}
                    },
                    {
                        tag: 'create_general_chat',
                        attrs: {}
                    }
                ]
            }
        ]);
        const groupNode = getBinaryNodeChild(result, 'group');
        if (groupNode) {
            const gid = groupNode.attrs?.id;
            if (gid && groupMetadata) {
                const jid = gid.includes('@') ? gid : gid + '@g.us';
                return groupMetadata(jid).catch(() => null);
            }
        }
        return null;
    }

    async function communityCreateGroup(subject, participants, parentCommunityJid) {
        const key = generateMessageTag();
        const result = await communityQuery('@g.us', 'set', [
            {
                tag: 'create',
                attrs: { subject, key },
                content: [
                    ...participants.map(jid => ({
                        tag: 'participant',
                        attrs: { jid }
                    })),
                    { tag: 'linked_parent', attrs: { jid: parentCommunityJid } }
                ]
            }
        ]);
        const groupNode = getBinaryNodeChild(result, 'group');
        if (groupNode) {
            const gid = groupNode.attrs?.id;
            if (gid && groupMetadata) {
                const jid = gid.includes('@') ? gid : gid + '@g.us';
                return groupMetadata(jid).catch(() => null);
            }
        }
        return null;
    }

    async function communityLeave(id) {
        await communityQuery('@g.us', 'set', [
            {
                tag: 'leave',
                attrs: {},
                content: [{ tag: 'community', attrs: { id } }]
            }
        ]);
    }

    async function communityUpdateSubject(jid, subject) {
        await communityQuery(jid, 'set', [
            {
                tag: 'subject',
                attrs: {},
                content: Buffer.from(subject, 'utf-8')
            }
        ]);
    }

    async function communityLinkGroup(groupJid, parentCommunityJid) {
        await communityQuery(parentCommunityJid, 'set', [
            {
                tag: 'links',
                attrs: {},
                content: [
                    {
                        tag: 'link',
                        attrs: { link_type: 'sub_group' },
                        content: [{ tag: 'group', attrs: { jid: groupJid } }]
                    }
                ]
            }
        ]);
    }

    async function communityUnlinkGroup(groupJid, parentCommunityJid) {
        await communityQuery(parentCommunityJid, 'set', [
            {
                tag: 'unlink',
                attrs: { unlink_type: 'sub_group' },
                content: [{ tag: 'group', attrs: { jid: groupJid } }]
            }
        ]);
    }

    async function communityFetchLinkedGroups(jid) {
        let communityJid = jid;
        let isCommunity = false;

        if (groupMetadata) {
            const metadata = await groupMetadata(jid);
            if (metadata?.linkedParent) {
                communityJid = metadata.linkedParent;
            } else {
                isCommunity = true;
            }
        }

        const result = await communityQuery(communityJid, 'get', [
            { tag: 'sub_groups', attrs: {} }
        ]);

        const linkedGroups = [];
        const subGroupsNode = getBinaryNodeChild(result, 'sub_groups');
        if (subGroupsNode) {
            const groupNodes = getBinaryNodeChildren(subGroupsNode, 'group');
            for (const groupNode of groupNodes) {
                linkedGroups.push({
                    id: groupNode.attrs?.id ? jidEncode(groupNode.attrs.id, 'g.us') : undefined,
                    subject: groupNode.attrs?.subject || '',
                    creation: groupNode.attrs?.creation ? +groupNode.attrs.creation : undefined,
                    owner: groupNode.attrs?.creator ? jidNormalizedUser(groupNode.attrs.creator) : undefined,
                    size: groupNode.attrs?.size ? +groupNode.attrs.size : undefined
                });
            }
        }

        return { communityJid, isCommunity, linkedGroups };
    }

    async function communityFetchAllParticipating() {
        const result = await query({
            tag: 'iq',
            attrs: {
                id: generateMessageTag(),
                to: '@g.us',
                xmlns: 'w:g2',
                type: 'get'
            },
            content: [
                {
                    tag: 'participating',
                    attrs: {},
                    content: [
                        { tag: 'participants', attrs: {} },
                        { tag: 'description', attrs: {} }
                    ]
                }
            ]
        });

        const data = {};
        const communitiesChild = getBinaryNodeChild(result, 'communities');
        if (communitiesChild) {
            const communities = getBinaryNodeChildren(communitiesChild, 'community');
            for (const communityNode of communities) {
                const meta = extractCommunityMetadata({
                    tag: 'result',
                    attrs: {},
                    content: [communityNode]
                });
                data[meta.id] = meta;
            }
        }
        return data;
    }

    async function communityUpdateDescription(jid, description) {
        const metadata = await communityMetadata(jid).catch(() => null);
        const prev = metadata?.descId || null;

        const descAttrs = {};
        if (description) {
            descAttrs.id = generateMessageTag();
        } else {
            descAttrs.delete = 'true';
        }
        if (prev) {
            descAttrs.prev = prev;
        }

        await communityQuery(jid, 'set', [
            {
                tag: 'description',
                attrs: descAttrs,
                content: description
                    ? [{ tag: 'body', attrs: {}, content: Buffer.from(description, 'utf-8') }]
                    : undefined
            }
        ]);
    }

    async function communityUpdatePicture(jid, imgBuffer) {
        const result = await query({
            tag: 'iq',
            attrs: {
                id: generateMessageTag(),
                to: jid,
                type: 'set',
                xmlns: 'w:profile:picture'
            },
            content: [
                {
                    tag: 'picture',
                    attrs: { type: 'image' },
                    content: imgBuffer
                }
            ]
        });
        return result;
    }

    async function communityDeactivate(jid) {
        await communityQuery(jid, 'set', [
            { tag: 'delete', attrs: {} }
        ]);
    }

    async function communityInviteCode(jid) {
        const result = await communityQuery(jid, 'get', [
            { tag: 'invite', attrs: {} }
        ]);
        const inviteNode = getBinaryNodeChild(result, 'invite');
        return inviteNode?.attrs?.code;
    }

    async function communityRevokeInvite(jid) {
        const result = await communityQuery(jid, 'set', [
            { tag: 'invite', attrs: {} }
        ]);
        const inviteNode = getBinaryNodeChild(result, 'invite');
        return inviteNode?.attrs?.code;
    }

    async function communityAcceptInvite(code) {
        const results = await communityQuery('@g.us', 'set', [
            { tag: 'invite', attrs: { code } }
        ]);
        const communityNode = getBinaryNodeChild(results, 'community');
        return communityNode?.attrs?.jid;
    }

    async function communityGetInviteInfo(code) {
        const results = await communityQuery('@g.us', 'get', [
            { tag: 'invite', attrs: { code } }
        ]);
        return extractCommunityMetadata(results);
    }

    async function communityRevokeInviteV4(communityJid, invitedJid) {
        const result = await communityQuery(communityJid, 'set', [
            {
                tag: 'revoke',
                attrs: {},
                content: [{ tag: 'participant', attrs: { jid: invitedJid } }]
            }
        ]);
        return !!result;
    }

    async function communityRequestParticipantsList(jid) {
        const result = await communityQuery(jid, 'get', [
            { tag: 'membership_approval_requests', attrs: {} }
        ]);
        const node = getBinaryNodeChild(result, 'membership_approval_requests');
        const participants = getBinaryNodeChildren(node || result, 'membership_approval_request');
        return participants.map(v => v.attrs);
    }

    async function communityRequestParticipantsUpdate(jid, participants, action) {
        const result = await communityQuery(jid, 'set', [
            {
                tag: 'membership_requests_action',
                attrs: {},
                content: [
                    {
                        tag: action,
                        attrs: {},
                        content: participants.map(p => ({
                            tag: 'participant',
                            attrs: { jid: p }
                        }))
                    }
                ]
            }
        ]);
        const node = getBinaryNodeChild(result, 'membership_requests_action');
        const nodeAction = getBinaryNodeChild(node || result, action);
        const affected = getBinaryNodeChildren(nodeAction || result, 'participant');
        return affected.map(p => ({
            status: p.attrs?.error || '200',
            jid: p.attrs?.jid
        }));
    }

    async function communityParticipantsUpdate(jid, participants, action) {
        const result = await communityQuery(jid, 'set', [
            {
                tag: action,
                attrs: action === 'remove' ? { linked_groups: 'true' } : {},
                content: participants.map(p => ({
                    tag: 'participant',
                    attrs: { jid: p }
                }))
            }
        ]);
        const node = getBinaryNodeChild(result, action);
        const affected = getBinaryNodeChildren(node || result, 'participant');
        return affected.map(p => ({
            status: p.attrs?.error || '200',
            jid: p.attrs?.jid,
            content: p
        }));
    }

    async function communityToggleEphemeral(jid, ephemeralExpiration) {
        const content = ephemeralExpiration
            ? { tag: 'ephemeral', attrs: { expiration: String(ephemeralExpiration) } }
            : { tag: 'not_ephemeral', attrs: {} };
        await communityQuery(jid, 'set', [content]);
    }

    async function communitySettingUpdate(jid, setting) {
        await communityQuery(jid, 'set', [
            { tag: setting, attrs: {} }
        ]);
    }

    async function communityMemberAddMode(jid, mode) {
        await communityQuery(jid, 'set', [
            { tag: 'member_add_mode', attrs: {}, content: mode }
        ]);
    }

    async function communityJoinApprovalMode(jid, mode) {
        await communityQuery(jid, 'set', [
            {
                tag: 'membership_approval_mode',
                attrs: {},
                content: [
                    { tag: 'community_join', attrs: { state: mode } }
                ]
            }
        ]);
    }

    async function communityAcceptInviteV4(key, inviteMessage) {
        if (typeof key === 'string') {
            key = { remoteJid: key };
        }
        const results = await communityQuery(inviteMessage.groupJid, 'set', [
            {
                tag: 'accept',
                attrs: {
                    code: inviteMessage.inviteCode,
                    expiration: String(inviteMessage.inviteExpiration),
                    admin: key.remoteJid
                }
            }
        ]);
        if (key.id && ev) {
            const expired = { ...inviteMessage, inviteExpiration: 0, inviteCode: '' };
            ev.emit('messages.update', [{
                key,
                update: {
                    message: { groupInviteMessage: expired }
                }
            }]);
        }
        if (upsertMessage) {
            await upsertMessage({
                key: {
                    remoteJid: inviteMessage.groupJid,
                    id: generateMessageIDV2(authState?.creds?.me?.id),
                    fromMe: false,
                    participant: key.remoteJid
                },
                messageStubType: 27,
                messageStubParameters: [JSON.stringify(authState?.creds?.me)],
                participant: key.remoteJid,
                messageTimestamp: unixTimestampSeconds()
            }, 'notify');
        }
        return results.attrs?.from;
    }

    return {
        communityMetadata,
        communityCreate,
        communityCreateGroup,
        communityLeave,
        communityUpdateSubject,
        communityLinkGroup,
        communityUnlinkGroup,
        communityFetchLinkedGroups,
        communityFetchAllParticipating,
        communityUpdateDescription,
        communityUpdatePicture,
        communityDeactivate,
        communityInviteCode,
        communityRevokeInvite,
        communityAcceptInvite,
        communityAcceptInviteV4,
        communityGetInviteInfo,
        communityRevokeInviteV4,
        communityRequestParticipantsList,
        communityRequestParticipantsUpdate,
        communityParticipantsUpdate,
        communityToggleEphemeral,
        communitySettingUpdate,
        communityMemberAddMode,
        communityJoinApprovalMode
    };
}

module.exports = {
    makeCommunitiesSocket,
    extractCommunityMetadata
};
