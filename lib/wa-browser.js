'use strict';

const os = require('os');

const OS_VERSIONS = {
    'Ubuntu': '22.04.4',
    'Linux': '6.5.0',
    'Mac OS': '14.4.1',
    'Windows': '10.0.22631',
    'FreeBSD': '14.0',
    'OpenBSD': '7.5',
    'Android': '14.0',
    'iOS': '17.4.1',
    'Chrome OS': '120.0',
    'Fedora': '39',
    'Debian': '12.5',
    'Arch': '2024.03.01',
    'CentOS': '9',
    'Red Hat': '9.3',
    'Mint': '21.3',
    'Manjaro': '23.1',
    'Kali': '2024.1',
    'openSUSE': '15.5',
    'Solaris': '11.4',
    'AIX': '7.3',
    'Haiku': 'R1/beta5',
    'Tizen': '8.0',
    'HarmonyOS': '4.0',
    'KaiOS': '3.1',
    'Sailfish': '4.5',
    'Fuchsia': '1.0',
};

const BROWSER_VERSIONS = {
    'Chrome': '131.0.6778.86',
    'Firefox': '133.0',
    'Safari': '17.4.1',
    'Edge': '131.0.2903.70',
    'Opera': '115.0.5322.109',
    'Brave': '1.73.97',
    'Vivaldi': '7.0.3495.23',
    'Arc': '1.73.0',
    'Chromium': '131.0.6778.86',
    'Tor': '13.5.8',
    'Waterfox': '6.0.20',
    'LibreWolf': '133.0',
    'Pale Moon': '33.0.1',
    'Midori': '11.5',
    'Falkon': '24.08',
    'Epiphany': '46.0',
    'Konqueror': '24.08',
    'Yandex': '24.12',
    'Samsung Internet': '25.0',
    'UC Browser': '15.6',
    'Silk': '100.6.1',
    'Maxthon': '7.2.2',
    'Whale': '4.0',
    'DuckDuckGo': '0.82',
    'Lynx': '2.9.2',
    'Orion': '0.99',
    'Ungoogled Chromium': '131.0.6778.86',
};

const PLATFORM_MAP = {
    aix: 'AIX',
    darwin: 'Mac OS',
    win32: 'Windows',
    android: 'Android',
    freebsd: 'FreeBSD',
    openbsd: 'OpenBSD',
    sunos: 'Solaris',
    linux: 'Ubuntu',
    haiku: 'Haiku',
    cygwin: 'Windows',
    netbsd: 'FreeBSD'
};

const PLATFORM_TYPE_MAP = {
    'CHROME': 1,
    'FIREFOX': 2,
    'IE': 3,
    'INTERNET EXPLORER': 3,
    'OPERA': 4,
    'SAFARI': 5,
    'EDGE': 6,
    'DESKTOP': 7,
    'IPAD': 8,
    'ANDROID_TABLET': 9,
    'OHANA': 10,
    'ALOHA': 11,
    'CATALINA': 12,
    'TCL_TV': 13,
    'IOS_PHONE': 14,
    'IOS_CATALYST': 15,
    'ANDROID_PHONE': 16,
    'ANDROID_AMBIGUOUS': 17,
    'WEAR_OS': 18,
    'AR_WRIST': 19,
    'AR_DEVICE': 20,
    'UWP': 21,
    'VR': 22,
    'BRAVE': 1,
    'VIVALDI': 1,
    'ARC': 1,
    'CHROMIUM': 1,
    'UNGOOGLED CHROMIUM': 1,
    'TOR': 2,
    'WATERFOX': 2,
    'LIBREWOLF': 2,
    'PALE MOON': 2,
    'MIDORI': 1,
    'FALKON': 1,
    'EPIPHANY': 1,
    'KONQUEROR': 1,
    'YANDEX': 1,
    'SAMSUNG INTERNET': 1,
    'UC BROWSER': 1,
    'SILK': 1,
    'MAXTHON': 1,
    'WHALE': 1,
    'DUCKDUCKGO': 1,
    'LYNX': 1,
    'ORION': 5,
};

function makeBrowserDesc(osName, browserName, osVersion) {
    const resolvedOsVersion = osVersion || OS_VERSIONS[osName] || '1.0';
    return [osName, browserName, resolvedOsVersion];
}

function custom(osName, browserName, osVersion) {
    return makeBrowserDesc(osName, browserName, osVersion);
}

const Browsers = {
    ubuntu: (browser) => makeBrowserDesc('Ubuntu', browser || 'Chrome', OS_VERSIONS['Ubuntu']),
    macOS: (browser) => makeBrowserDesc('Mac OS', browser || 'Safari', OS_VERSIONS['Mac OS']),
    windows: (browser) => makeBrowserDesc('Windows', browser || 'Chrome', OS_VERSIONS['Windows']),
    linux: (browser) => makeBrowserDesc('Linux', browser || 'Chrome', OS_VERSIONS['Linux']),
    fedora: (browser) => makeBrowserDesc('Fedora', browser || 'Firefox', OS_VERSIONS['Fedora']),
    debian: (browser) => makeBrowserDesc('Debian', browser || 'Firefox', OS_VERSIONS['Debian']),
    arch: (browser) => makeBrowserDesc('Arch', browser || 'Firefox', OS_VERSIONS['Arch']),
    centOS: (browser) => makeBrowserDesc('CentOS', browser || 'Chrome', OS_VERSIONS['CentOS']),
    redHat: (browser) => makeBrowserDesc('Red Hat', browser || 'Firefox', OS_VERSIONS['Red Hat']),
    mint: (browser) => makeBrowserDesc('Mint', browser || 'Firefox', OS_VERSIONS['Mint']),
    manjaro: (browser) => makeBrowserDesc('Manjaro', browser || 'Firefox', OS_VERSIONS['Manjaro']),
    kali: (browser) => makeBrowserDesc('Kali', browser || 'Firefox', OS_VERSIONS['Kali']),
    openSUSE: (browser) => makeBrowserDesc('openSUSE', browser || 'Firefox', OS_VERSIONS['openSUSE']),
    freeBSD: (browser) => makeBrowserDesc('FreeBSD', browser || 'Firefox', OS_VERSIONS['FreeBSD']),
    openBSD: (browser) => makeBrowserDesc('OpenBSD', browser || 'Firefox', OS_VERSIONS['OpenBSD']),
    android: (browser) => makeBrowserDesc('Android', browser || 'Chrome', OS_VERSIONS['Android']),
    iOS: (browser) => makeBrowserDesc('iOS', browser || 'Safari', OS_VERSIONS['iOS']),
    chromeOS: (browser) => makeBrowserDesc('Chrome OS', browser || 'Chrome', OS_VERSIONS['Chrome OS']),
    solaris: (browser) => makeBrowserDesc('Solaris', browser || 'Firefox', OS_VERSIONS['Solaris']),
    aix: (browser) => makeBrowserDesc('AIX', browser || 'Firefox', OS_VERSIONS['AIX']),
    haiku: (browser) => makeBrowserDesc('Haiku', browser || 'Epiphany', OS_VERSIONS['Haiku']),
    tizen: (browser) => makeBrowserDesc('Tizen', browser || 'Samsung Internet', OS_VERSIONS['Tizen']),
    harmonyOS: (browser) => makeBrowserDesc('HarmonyOS', browser || 'Chrome', OS_VERSIONS['HarmonyOS']),
    kaiOS: (browser) => makeBrowserDesc('KaiOS', browser || 'Firefox', OS_VERSIONS['KaiOS']),
    sailfish: (browser) => makeBrowserDesc('Sailfish', browser || 'Firefox', OS_VERSIONS['Sailfish']),
    fuchsia: (browser) => makeBrowserDesc('Fuchsia', browser || 'Chrome', OS_VERSIONS['Fuchsia']),
    whalib: (browser) => makeBrowserDesc('Ubuntu', browser || 'Chrome', OS_VERSIONS['Ubuntu']),
    appropriate: (browser) => {
        const detectedOS = PLATFORM_MAP[os.platform()] || 'Ubuntu';
        const osVer = OS_VERSIONS[detectedOS] || os.release();
        return makeBrowserDesc(detectedOS, browser || 'Chrome', osVer);
    },
    custom: custom,
};

function getPlatformId(browserName) {
    const key = (browserName || 'Chrome').toUpperCase();
    return (PLATFORM_TYPE_MAP[key] || 1).toString();
}

function getBrowserVersion(browserName) {
    return BROWSER_VERSIONS[browserName] || null;
}

function getOSVersion(osName) {
    return OS_VERSIONS[osName] || null;
}

function listSupportedBrowsers() {
    return Object.keys(BROWSER_VERSIONS);
}

function listSupportedPlatforms() {
    return Object.keys(OS_VERSIONS);
}

module.exports = {
    Browsers,
    getPlatformId,
    getBrowserVersion,
    getOSVersion,
    listSupportedBrowsers,
    listSupportedPlatforms,
    OS_VERSIONS,
    BROWSER_VERSIONS,
    PLATFORM_TYPE_MAP,
    PLATFORM_MAP,
    custom,
};
