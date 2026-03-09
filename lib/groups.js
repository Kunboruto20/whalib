'use strict';

const {
    getBinaryNodeChild,
    getBinaryNodeChildren,
    getBinaryNodeChildBuffer
} = require('./binary-node');
const { jidEncode, jidNormalizedUser, jidDecode } = require('./jid-utils');
const { S_WHATSAPP_NET } = require('./constants');

function extractGroupMetadata(result) {
    const group = result.attrs || {};
    const descChild = getBinaryNodeChild(result, 'description');
    const subjectChild = result.attrs?.subject;
    const participants = getBinaryNodeChildren(result, 'participant');
    const announceChild = getBinaryNodeChild(result, 'announcement');
    const restrictChild = getBinaryNodeChild(result, 'locked');
    const ephemeralChild = getBinaryNodeChild(result, 'ephemeral');
    const memberAddModeChild = getBinaryNodeChild(result, 'member_add_mode');

    const descId = descChild?.attrs?.id;
    const descBody = getBinaryNodeChild(descChild, 'body');
    const desc = descBody?.content
        ? (Buffer.isBuffer(descBody.content) ? descBody.content.toString('utf-8') : String(descBody.content))
        : undefined;

    const metadata = {
        id: group.id?.includes('@') ? group.id : jidEncode(group.id, 'g.us'),
        subject: subjectChild || '',
        subjectOwner: group.s_o,
        subjectTime: group.s_t ? +group.s_t : undefined,
        size: participants.length,
        creation: group.creation ? +group.creation : undefined,
        owner: group.creator ? jidNormalizedUser(group.creator) : undefined,
        desc,
        descId,
        restrict: !!restrictChild,
        announce: !!announceChild,
        isCommunity: group.parent_group_jid !== undefined,
        isCommunityAnnounce: group.default_sub_group === 'true',
        joinApprovalMode: group.join_approval_mode === 'on',
        memberAddMode: memberAddModeChild?.content
            ? (Buffer.isBuffer(memberAddModeChild.content) ? memberAddModeChild.content.toString('utf-8') : String(memberAddModeChild.content))
            : undefined,
        participants: participants.map(p => ({
            id: p.attrs?.jid,
            admin: p.attrs?.type || null,
            isAdmin: p.attrs?.type === 'admin' || p.attrs?.type === 'superadmin',
            isSuperAdmin: p.attrs?.type === 'superadmin'
        })),
        ephemeralDuration: ephemeralChild?.attrs?.expiration ? +ephemeralChild.attrs.expiration : undefined
    };

    return metadata;
}

function makeGroupsSocket({ query, generateMessageTag }) {

    async function groupQuery(tag, jid, content, extraAttrs) {
        const node = {
            tag: 'iq',
            attrs: {
                id: generateMessageTag(),
                type: 'set',
                xmlns: 'w:g2',
                to: jid,
                ...extraAttrs
            },
            content: content ? (Array.isArray(content) ? content : [content]) : undefined
        };
        return query(node);
    }

    async function groupMetadata(jid) {
        const result = await query({
            tag: 'iq',
            attrs: {
                id: generateMessageTag(),
                type: 'get',
                xmlns: 'w:g2',
                to: jid
            },
            content: [{ tag: 'query', attrs: { request: 'interactive' } }]
        });
        return extractGroupMetadata(getBinaryNodeChild(result, 'group') || result);
    }

    async function groupCreate(subject, participants) {
        const participantNodes = participants.map(jid => ({
            tag: 'participant',
            attrs: { jid }
        }));
        const result = await groupQuery('iq', '@g.us', [
            {
                tag: 'create',
                attrs: { subject, key: generateMessageTag() },
                content: participantNodes
            }
        ], { to: '@g.us' });
        const groupNode = getBinaryNodeChild(result, 'group');
        return extractGroupMetadata(groupNode || result);
    }

    async function groupLeave(jid) {
        return groupQuery('iq', '@g.us', [
            {
                tag: 'leave',
                attrs: {},
                content: [{ tag: 'group', attrs: { id: jid } }]
            }
        ], { to: '@g.us' });
    }

    async function groupUpdateSubject(jid, subject) {
        return groupQuery('iq', jid, [
            { tag: 'subject', attrs: {}, content: Buffer.from(subject, 'utf-8') }
        ]);
    }

    async function groupUpdateDescription(jid, description) {
        const metadata = await groupMetadata(jid).catch(() => null);
        const prev = metadata?.descId;

        const content = [];
        if (description) {
            content.push({
                tag: 'body',
                attrs: {},
                content: Buffer.from(description, 'utf-8')
            });
        }

        const descAttrs = { id: generateMessageTag() };
        if (prev) {
            descAttrs.prev = prev;
        }
        if (!description) {
            descAttrs.delete = 'true';
        }

        return groupQuery('iq', jid, [
            {
                tag: 'description',
                attrs: descAttrs,
                content: content.length ? content : undefined
            }
        ]);
    }

    async function groupSettingUpdate(jid, setting) {
        let content;
        if (setting === 'announcement' || setting === 'not_announcement') {
            content = [{ tag: setting === 'announcement' ? 'announcement' : 'not_announcement', attrs: {} }];
        } else if (setting === 'locked' || setting === 'unlocked') {
            content = [{ tag: setting, attrs: {} }];
        } else {
            content = [{ tag: setting, attrs: {} }];
        }
        return groupQuery('iq', jid, content);
    }

    async function groupParticipantsUpdate(jid, participants, action) {
        const participantNodes = participants.map(p => ({
            tag: 'participant',
            attrs: { jid: p }
        }));
        const result = await groupQuery('iq', jid, [
            {
                tag: action,
                attrs: {},
                content: participantNodes
            }
        ]);
        const node = getBinaryNodeChild(result, action);
        const statusParticipants = getBinaryNodeChildren(node || result, 'participant');
        return statusParticipants.map(p => ({
            jid: p.attrs?.jid,
            status: p.attrs?.error || '200'
        }));
    }

    async function groupInviteCode(jid) {
        const result = await query({
            tag: 'iq',
            attrs: {
                id: generateMessageTag(),
                type: 'get',
                xmlns: 'w:g2',
                to: jid
            },
            content: [{ tag: 'invite', attrs: {} }]
        });
        const inviteNode = getBinaryNodeChild(result, 'invite');
        return inviteNode?.attrs?.code;
    }

    async function groupRevokeInvite(jid) {
        const result = await query({
            tag: 'iq',
            attrs: {
                id: generateMessageTag(),
                type: 'set',
                xmlns: 'w:g2',
                to: jid
            },
            content: [{ tag: 'invite', attrs: {} }]
        });
        const inviteNode = getBinaryNodeChild(result, 'invite');
        return inviteNode?.attrs?.code;
    }

    async function groupAcceptInvite(code) {
        const result = await query({
            tag: 'iq',
            attrs: {
                id: generateMessageTag(),
                type: 'set',
                xmlns: 'w:g2',
                to: '@g.us'
            },
            content: [{ tag: 'invite', attrs: { code } }]
        });
        const groupNode = getBinaryNodeChild(result, 'group');
        return groupNode?.attrs?.jid || groupNode?.attrs?.id;
    }

    async function groupFetchAllParticipating() {
        const result = await query({
            tag: 'iq',
            attrs: {
                id: generateMessageTag(),
                type: 'get',
                xmlns: 'w:g2',
                to: '@g.us'
            },
            content: [{ tag: 'participating', attrs: {}, content: [{ tag: 'participants', attrs: {} }, { tag: 'description', attrs: {} }] }]
        });

        const groups = {};
        const participatingNode = getBinaryNodeChild(result, 'groups');
        const groupNodes = getBinaryNodeChildren(participatingNode || result, 'group');
        for (const groupNode of groupNodes) {
            const meta = extractGroupMetadata(groupNode);
            groups[meta.id] = meta;
        }
        return groups;
    }

    async function groupToggleEphemeral(jid, ephemeralExpiration) {
        const payload = ephemeralExpiration
            ? { tag: 'ephemeral', attrs: { expiration: String(ephemeralExpiration) } }
            : { tag: 'not_ephemeral', attrs: {} };
        return groupQuery('iq', jid, [payload]);
    }

    async function groupGetInviteInfo(code) {
        const result = await query({
            tag: 'iq',
            attrs: {
                id: generateMessageTag(),
                type: 'get',
                xmlns: 'w:g2',
                to: '@g.us'
            },
            content: [{ tag: 'invite', attrs: { code } }]
        });
        return extractGroupMetadata(getBinaryNodeChild(result, 'group') || result);
    }

    async function groupAcceptInviteV4(key, inviteMessage) {
        const senderJid = typeof key === 'string' ? key : key?.remoteJid;
        if (!senderJid) {
            throw new Error('groupAcceptInviteV4 requires a valid key with remoteJid or a JID string');
        }

        const targetGroup = inviteMessage.groupJid;
        const result = await query({
            tag: 'iq',
            attrs: {
                id: generateMessageTag(),
                type: 'set',
                xmlns: 'w:g2',
                to: targetGroup
            },
            content: [{
                tag: 'accept',
                attrs: {
                    code: inviteMessage.inviteCode,
                    expiration: String(inviteMessage.inviteExpiration || '0'),
                    admin: senderJid
                }
            }]
        });

        return result?.attrs?.from;
    }

    async function groupRevokeInviteV4(groupJid, invitedJid) {
        const result = await groupQuery('iq', groupJid, [{
            tag: 'revoke',
            attrs: {},
            content: [{ tag: 'participant', attrs: { jid: invitedJid } }]
        }]);
        return !!result;
    }

    async function groupRequestParticipantsList(jid) {
        const result = await query({
            tag: 'iq',
            attrs: {
                id: generateMessageTag(),
                type: 'get',
                xmlns: 'w:g2',
                to: jid
            },
            content: [{ tag: 'membership_approval_requests', attrs: {} }]
        });
        const container = getBinaryNodeChild(result, 'membership_approval_requests');
        const entries = getBinaryNodeChildren(container || result, 'membership_approval_request');
        return entries.map(e => e.attrs);
    }

    async function groupRequestParticipantsUpdate(jid, participants, action) {
        const result = await groupQuery('iq', jid, [{
            tag: 'membership_requests_action',
            attrs: {},
            content: [{
                tag: action,
                attrs: {},
                content: participants.map(p => ({
                    tag: 'participant',
                    attrs: { jid: p }
                }))
            }]
        }]);
        const actionContainer = getBinaryNodeChild(result, 'membership_requests_action');
        const actionNode = getBinaryNodeChild(actionContainer || result, action);
        const affected = getBinaryNodeChildren(actionNode || result, 'participant');
        return affected.map(p => ({
            status: p.attrs?.error || '200',
            jid: p.attrs?.jid
        }));
    }

    async function groupJoinApprovalMode(jid, mode) {
        return groupQuery('iq', jid, [{
            tag: 'membership_approval_mode',
            attrs: {},
            content: [{ tag: 'group_join', attrs: { state: mode } }]
        }]);
    }

    async function groupMemberAddMode(jid, mode) {
        return groupQuery('iq', jid, [{
            tag: 'member_add_mode',
            attrs: {},
            content: mode
        }]);
    }

    return {
        groupMetadata,
        groupCreate,
        groupLeave,
        groupUpdateSubject,
        groupUpdateDescription,
        groupSettingUpdate,
        groupParticipantsUpdate,
        groupInviteCode,
        groupRevokeInvite,
        groupAcceptInvite,
        groupFetchAllParticipating,
        groupToggleEphemeral,
        groupGetInviteInfo,
        groupAcceptInviteV4,
        groupRevokeInviteV4,
        groupRequestParticipantsList,
        groupRequestParticipantsUpdate,
        groupJoinApprovalMode,
        groupMemberAddMode
    };
}

module.exports = {
    makeGroupsSocket,
    extractGroupMetadata
};
