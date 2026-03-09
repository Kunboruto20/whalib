'use strict';

const S_WHATSAPP_NET = 's.whatsapp.net';

const WAJIDDomains = {
    WHATSAPP: 0,
    LID: 1,
    HOSTED: 2,
    HOSTED_LID: 3
};

function jidDecode(jid) {
    if (!jid || typeof jid !== 'string') return null;
    const sepIdx = jid.indexOf('@');
    if (sepIdx < 0) return null;
    const userPart = jid.slice(0, sepIdx);
    const server = jid.slice(sepIdx + 1);
    const colonIdx = userPart.indexOf(':');
    if (colonIdx >= 0) {
        const parts = userPart.split(':');
        return {
            user: parts[0],
            device: parseInt(parts[parts.length - 1], 10) || 0,
            server,
            domainType: server === 'lid' ? WAJIDDomains.LID : WAJIDDomains.WHATSAPP
        };
    }
    return { user: userPart, server };
}

function jidEncode(user, server, device) {
    server = server || S_WHATSAPP_NET;
    let jid = user || '';
    if (typeof device === 'number' && device > 0) {
        jid += ':' + device;
    }
    return jid + '@' + server;
}

function jidNormalizedUser(jid) {
    const decoded = jidDecode(jid);
    if (!decoded) return jid;
    return jidEncode(decoded.user, decoded.server);
}

function isJidGroup(jid) {
    if (!jid) return false;
    return jid.endsWith('@g.us');
}

function isJidStatusBroadcast(jid) {
    return jid === 'status@broadcast';
}

function isJidBroadcast(jid) {
    if (!jid) return false;
    return jid.endsWith('@broadcast');
}

function isJidNewsletter(jid) {
    if (!jid) return false;
    return jid.endsWith('@newsletter');
}

function isLidUser(jid) {
    if (!jid) return false;
    return jid.endsWith('@lid');
}

function isPnUser(jid) {
    if (!jid) return false;
    return jid.endsWith('@' + S_WHATSAPP_NET);
}

function areJidsSameUser(jid1, jid2) {
    if (!jid1 || !jid2) return false;
    const d1 = jidDecode(jid1);
    const d2 = jidDecode(jid2);
    if (!d1 || !d2) return false;
    return d1.user === d2.user;
}

module.exports = {
    S_WHATSAPP_NET,
    WAJIDDomains,
    jidDecode,
    jidEncode,
    jidNormalizedUser,
    isJidGroup,
    isJidBroadcast,
    isJidStatusBroadcast,
    isJidNewsletter,
    isLidUser,
    isPnUser,
    areJidsSameUser
};
