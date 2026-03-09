'use strict';

const { createHash } = require('crypto');
const { Curve, hmacSign, encodeBigEndian, generateSignalPubKey } = require('./crypto-utils');
const { getBinaryNodeChild } = require('./binary-node');
const { jidDecode } = require('./jid-utils');
const {
    KEY_BUNDLE_TYPE,
    WA_WEB_VERSION,
    WA_BROWSER_DESC,
    S_WHATSAPP_NET
} = require('./constants');

const WA_ADV_ACCOUNT_SIG_PREFIX = Buffer.from([6, 0]);
const WA_ADV_DEVICE_SIG_PREFIX = Buffer.from([6, 1]);
const WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX = Buffer.from([6, 5]);

function getUserAgent(config) {
    const version = config.version || WA_WEB_VERSION;
    return {
        appVersion: {
            primary: version[0],
            secondary: version[1],
            tertiary: version[2]
        },
        platform: 14,
        releaseChannel: 0,
        osVersion: '0.1',
        device: 'Desktop',
        osBuildNumber: '0.1',
        localeLanguageIso6391: 'en',
        mnc: '000',
        mcc: '000',
        localeCountryIso31661Alpha2: config.countryCode || 'US'
    };
}

function getWebInfo(config) {
    let webSubPlatform = 0;
    const browser = config.browser || WA_BROWSER_DESC;
    if (config.syncFullHistory && browser[1] === 'Desktop') {
        if (browser[0] === 'Mac OS') webSubPlatform = 3;
        else if (browser[0] === 'Windows') webSubPlatform = 4;
    }
    return { webSubPlatform };
}

function getClientPayload(config) {
    return {
        connectType: 1,
        connectReason: 1,
        userAgent: getUserAgent(config),
        webInfo: getWebInfo(config)
    };
}

function generateLoginNode(userJid, config) {
    const decoded = jidDecode(userJid) || {};
    const protobuf = require('protobufjs');
    const path = require('path');
    const root = protobuf.loadSync(path.join(__dirname, '..', 'proto', 'whatsapp.proto'));
    const ClientPayload = root.lookupType('proto.ClientPayload');
    const payload = {
        ...getClientPayload(config),
        passive: true,
        pull: true,
        username: parseInt(decoded.user, 10),
        device: decoded.device || 0,
        lidDbMigrated: false
    };
    return ClientPayload.fromObject(payload);
}

function generateRegistrationNode(creds, config) {
    const version = config.version || WA_WEB_VERSION;
    const browser = config.browser || WA_BROWSER_DESC;

    const appVersionBuf = createHash('md5')
        .update(version.join('.'))
        .digest();

    const companion = {
        os: browser[0],
        platformType: getPlatformType(browser[1]),
        requireFullSync: config.syncFullHistory || false,
        historySyncConfig: {
            storageQuotaMb: 10240,
            inlineInitialPayloadInE2EeMsg: true,
            recentSyncDaysLimit: undefined,
            supportCallLogHistory: false,
            supportBotUserAgentChatHistory: true,
            supportCagReactionsAndPolls: true,
            supportBizHostedMsg: true,
            supportRecentSyncChunkMessageCountTuning: true,
            supportHostedGroupMsg: true,
            supportFbidBotChatHistory: true,
            supportAddOnHistorySyncMigration: undefined,
            supportMessageAssociation: true,
            supportGroupHistory: false,
            onDemandReady: undefined,
            supportGuestChat: undefined
        },
        version: { primary: 10, secondary: 15, tertiary: 7 }
    };

    const protobuf = require('protobufjs');
    const path = require('path');
    const root = protobuf.loadSync(path.join(__dirname, '..', 'proto', 'whatsapp.proto'));
    const DeviceProps = root.lookupType('proto.DeviceProps');
    const ClientPayload = root.lookupType('proto.ClientPayload');
    const companionBytes = DeviceProps.encode(DeviceProps.fromObject(companion)).finish();

    const registerPayload = {
        ...getClientPayload(config),
        passive: false,
        pull: false,
        devicePairingData: {
            buildHash: appVersionBuf,
            deviceProps: companionBytes,
            eRegid: encodeBigEndian(creds.registrationId),
            eKeytype: KEY_BUNDLE_TYPE,
            eIdent: creds.signedIdentityKey.public,
            eSkeyId: encodeBigEndian(creds.signedPreKey.keyId, 3),
            eSkeyVal: creds.signedPreKey.keyPair.public,
            eSkeySig: creds.signedPreKey.signature
        }
    };

    return ClientPayload.fromObject(registerPayload);
}

function getPlatformType(platform) {
    const types = {
        'Chrome': 1, 'Firefox': 2, 'IE': 3, 'Opera': 4,
        'Safari': 5, 'Edge': 6, 'Desktop': 7
    };
    return types[platform] || 1;
}

function configureSuccessfulPairing(stanza, authInfo) {
    const { advSecretKey, signedIdentityKey, signalIdentities } = authInfo;
    const msgId = stanza.attrs.id;
    const pairSuccessNode = getBinaryNodeChild(stanza, 'pair-success');
    const deviceIdentityNode = getBinaryNodeChild(pairSuccessNode, 'device-identity');
    const platformNode = getBinaryNodeChild(pairSuccessNode, 'platform');
    const deviceNode = getBinaryNodeChild(pairSuccessNode, 'device');
    const businessNode = getBinaryNodeChild(pairSuccessNode, 'biz');

    if (!deviceIdentityNode || !deviceNode) {
        throw new Error('Missing device-identity or device in pair-success');
    }

    const bizName = businessNode?.attrs?.name;
    const jid = deviceNode.attrs.jid;
    const lid = deviceNode.attrs.lid;

    const rawIdentity = Buffer.isBuffer(deviceIdentityNode.content)
        ? deviceIdentityNode.content
        : Buffer.from(deviceIdentityNode.content);

    const proto = loadProtoForValidation();
    const { details, hmac: advHmac, accountType } = proto.ADVSignedDeviceIdentityHMAC.decode(rawIdentity);

    let hmacPrefix = Buffer.from([]);
    if (accountType !== undefined && accountType !== null && accountType === 1) {
        hmacPrefix = WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX;
    }

    const advSecretBuf = Buffer.from(advSecretKey, 'base64');
    const advSign = hmacSign(Buffer.concat([hmacPrefix, details]), advSecretBuf);

    if (Buffer.compare(advSign, advHmac) !== 0) {
        throw new Error('Invalid ADV account signature HMAC');
    }

    const account = proto.ADVSignedDeviceIdentity.decode(details);
    const { accountSignatureKey, accountSignature, details: deviceDetails } = account;

    const deviceIdentity = proto.ADVDeviceIdentity.decode(deviceDetails);

    const accountSignaturePrefix = deviceIdentity.deviceType === 1
        ? WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX
        : WA_ADV_ACCOUNT_SIG_PREFIX;

    const accountMsg = Buffer.concat([
        accountSignaturePrefix,
        deviceDetails,
        signedIdentityKey.public
    ]);
    if (!Curve.verify(accountSignatureKey, accountMsg, accountSignature)) {
        throw new Error('Invalid ADV account signature');
    }

    const deviceMsg = Buffer.concat([
        WA_ADV_DEVICE_SIG_PREFIX,
        deviceDetails,
        signedIdentityKey.public,
        accountSignatureKey
    ]);
    account.deviceSignature = Curve.sign(signedIdentityKey.private, deviceMsg);

    const accountEnc = encodeSignedDeviceIdentity(proto, account, false);

    const keyIndex = deviceIdentity.keyIndex || 0;

    return {
        creds: {
            me: { id: jid, name: bizName, lid },
            account,
            signalIdentities: [
                ...(signalIdentities || []),
                {
                    identifier: { name: lid, deviceId: 0 },
                    identifierKey: generateSignalPubKey(accountSignatureKey)
                }
            ],
            platform: platformNode?.attrs?.name
        },
        reply: {
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'result',
                id: msgId
            },
            content: [
                {
                    tag: 'pair-device-sign',
                    attrs: {},
                    content: [
                        {
                            tag: 'device-identity',
                            attrs: { 'key-index': String(keyIndex) },
                            content: accountEnc
                        }
                    ]
                }
            ]
        }
    };
}

function encodeSignedDeviceIdentity(proto, account, includeSignatureKey) {
    const obj = { ...account };
    if (!includeSignatureKey || !obj.accountSignatureKey?.length) {
        obj.accountSignatureKey = null;
    }
    return proto.ADVSignedDeviceIdentity.encode(obj).finish();
}

let _protoRoot = null;

function loadProtoForValidation() {
    if (_protoRoot) return _protoRoot;
    const protobuf = require('protobufjs');
    const path = require('path');
    const root = protobuf.loadSync(path.join(__dirname, '..', 'proto', 'whatsapp.proto'));
    _protoRoot = {
        ADVSignedDeviceIdentity: root.lookupType('proto.ADVSignedDeviceIdentity'),
        ADVSignedDeviceIdentityHMAC: root.lookupType('proto.ADVSignedDeviceIdentityHMAC'),
        ADVDeviceIdentity: root.lookupType('proto.ADVDeviceIdentity')
    };
    return _protoRoot;
}

module.exports = {
    generateLoginNode,
    generateRegistrationNode,
    configureSuccessfulPairing,
    getUserAgent,
    getWebInfo,
    getClientPayload,
    getPlatformType
};
