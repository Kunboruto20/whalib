'use strict';

const DICT_VERSION = 3;

const NOISE_WA_HEADER = Buffer.from([87, 65, 6, DICT_VERSION]);

const WA_WEB_URL = 'wss://web.whatsapp.com/ws/chat';

const WA_DEFAULT_ORIGIN = 'https://web.whatsapp.com';

const WA_WEB_VERSION = [2, 3000, 1034754302];

const WA_BROWSER_DESC = ['Ubuntu', 'Chrome', '22.04.4'];

const { Browsers, getPlatformId: getBrowserPlatformId } = require('./wa-browser');

const S_WHATSAPP_NET = 's.whatsapp.net';

const KEEP_ALIVE_INTERVAL = 30000;

const DEFAULT_QUERY_TIMEOUT = 60000;

const CONNECT_TIMEOUT = 20000;

const QR_TIMEOUT = 240000;

const INITIAL_PREKEY_COUNT = 30;

const MIN_PREKEY_COUNT = 5;

const KEY_BUNDLE_TYPE = Buffer.from([5]);

const DEF_TAG_PREFIX = 'TAG:';

const DEF_CALLBACK_PREFIX = 'CB:';

const NOISE_MODE = 'Noise_XX_25519_AESGCM_SHA256';

const DISCONNECT_REASON = {
    connectionClosed: 428,
    connectionLost: 408,
    connectionReplaced: 440,
    timedOut: 408,
    loggedOut: 401,
    badSession: 500,
    restartRequired: 515,
    multideviceMismatch: 411
};

const WA_CERT_DETAILS = {
    SERIAL: 0
};

module.exports = {
    DICT_VERSION,
    NOISE_WA_HEADER,
    NOISE_MODE,
    WA_WEB_URL,
    WA_DEFAULT_ORIGIN,
    WA_WEB_VERSION,
    WA_BROWSER_DESC,
    Browsers,
    S_WHATSAPP_NET,
    KEEP_ALIVE_INTERVAL,
    DEFAULT_QUERY_TIMEOUT,
    CONNECT_TIMEOUT,
    QR_TIMEOUT,
    INITIAL_PREKEY_COUNT,
    MIN_PREKEY_COUNT,
    KEY_BUNDLE_TYPE,
    DEF_TAG_PREFIX,
    DEF_CALLBACK_PREFIX,
    DISCONNECT_REASON,
    WA_CERT_DETAILS
};
