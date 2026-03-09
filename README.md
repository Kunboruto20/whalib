# whalib

**JavaScript / Node.js WhatsApp Web API Client**

A lightweight, dependency-minimal WhatsApp Web API client for Node.js. Connect to WhatsApp Multi-Device, send and receive messages, manage groups, handle media, and much more — all from your own backend.

[![npm version](https://img.shields.io/npm/v/whalib.svg)](https://www.npmjs.com/package/whalib)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org)

---

## Features

- Full WhatsApp Multi-Device protocol support
- QR Code and Pairing Code authentication
- Send and receive text, images, videos, audio, documents, stickers, locations, contacts, polls, and more
- End-to-end encryption via the Signal protocol (built-in implementation)
- Group management (create, update, participants, invites)
- Newsletter/Channel support
- Community management
- Business profile and catalog support
- Presence updates (typing, online/offline)
- Message receipts (delivered, read)
- Message editing, deletion, reactions, and pinning
- Disappearing messages
- Link preview generation
- Media upload and download with encryption
- Persistent session storage via filesystem
- Minimal dependencies, no native modules required

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Authentication](#authentication)
  - [QR Code](#qr-code)
  - [Pairing Code](#pairing-code)
- [Handling Events](#handling-events)
- [Sending Messages](#sending-messages)
  - [Text Messages](#text-messages)
  - [Images](#images)
  - [Videos](#videos)
  - [Audio and Voice Notes](#audio-and-voice-notes)
  - [Documents](#documents)
  - [Stickers](#stickers)
  - [Location](#location)
  - [Contacts](#contacts)
  - [Reactions](#reactions)
  - [Polls](#polls)
  - [Buttons and Lists](#buttons-and-lists)
- [Replying and Quoting](#replying-and-quoting)
- [Editing Messages](#editing-messages)
- [Deleting Messages](#deleting-messages)
- [Forwarding Messages](#forwarding-messages)
- [View Once Messages](#view-once-messages)
- [Disappearing Messages](#disappearing-messages)
- [Media Download](#media-download)
- [Presence Updates](#presence-updates)
- [Read Receipts](#read-receipts)
- [Profile](#profile)
- [Group Management](#group-management)
- [WhatsApp IDs (JIDs)](#whatsapp-ids-jids)
- [Socket Configuration](#socket-configuration)
  - [Browser & Platform Configuration](#browser--platform-configuration)
- [Events Reference](#events-reference)
- [Error Handling and Reconnection](#error-handling-and-reconnection)
- [License](#license)

---

## Installation

```bash
npm install whalib
```

**Requirements:** Node.js 18 or higher.

---

## Quick Start

```js
const { makeSocket, useMultiFileAuthState, Browsers } = require('whalib');

async function start() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_session');

    const sock = makeSocket({
        auth: state,
        browser: Browsers.ubuntu('Chrome')
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('Scan this QR code with WhatsApp:');
            // Use a library like 'qrcode-terminal' to display in console
        }

        if (connection === 'open') {
            console.log('Connected to WhatsApp!');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.statusCode;
            if (statusCode !== 401) {
                // Reconnect on non-logout disconnections
                setTimeout(start, 3000);
            } else {
                console.log('Logged out.');
            }
        }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
        for (const msg of messages) {
            if (!msg.key.fromMe && type === 'notify') {
                console.log('New message from', msg.key.remoteJid);
                console.log('Content:', msg.message);
            }
        }
    });
}

start();
```

---

## Authentication

whalib supports two methods to link your application as a companion device: **QR Code** and **Pairing Code**.

### QR Code

The default authentication method. When no existing session is found, whalib emits a `qr` string through the `connection.update` event. Display this QR code and scan it with WhatsApp on your phone (Linked Devices > Link a Device).

```js
const qrcode = require('qrcode-terminal');
const { makeSocket, useMultiFileAuthState, Browsers } = require('whalib');

async function connectWithQR() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_session');

    const sock = makeSocket({
        auth: state,
        browser: Browsers.ubuntu('Chrome')
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        if (update.qr) {
            qrcode.generate(update.qr, { small: true });
            console.log('Scan the QR code above with WhatsApp');
        }
        if (update.connection === 'open') {
            console.log('Successfully connected!');
        }
    });
}

connectWithQR();
```

### Pairing Code

Link your device using an 8-character code instead of scanning a QR code. This is useful for server environments without display access.

```js
const { makeSocket, useMultiFileAuthState, Browsers } = require('whalib');
const readline = require('readline');

async function connectWithPairingCode() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_session');

    const sock = makeSocket({
        auth: state,
        browser: Browsers.ubuntu('Chrome')
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        if (update.connection === 'connecting' && !state.creds.me) {
            // Request a pairing code for your phone number (with country code, no +)
            const code = await sock.requestPairingCode('1234567890');
            console.log('Enter this code on your phone:', code);
        }
        if (update.connection === 'open') {
            console.log('Paired successfully!');
        }
    });
}

connectWithPairingCode();
```

Open WhatsApp on your phone, go to **Linked Devices > Link a Device > Link with Phone Number**, and enter the code displayed in your console.

### Session Persistence

whalib stores session data in a folder you specify. As long as the folder exists and contains valid session files, subsequent connections will restore the session automatically without needing to scan a QR code or enter a pairing code again.

```js
// Session is saved in ./auth_session/
const { state, saveCreds } = await useMultiFileAuthState('./auth_session');

// Always save credential updates
sock.ev.on('creds.update', saveCreds);
```

To log out and remove the session:

```js
// This deregisters the companion device from WhatsApp
await sock.logout();

// Optionally delete the session folder
const fs = require('fs');
fs.rmSync('./auth_session', { recursive: true, force: true });
```

---

## Handling Events

whalib uses an event-based architecture. Subscribe to events using `sock.ev.on(eventName, handler)`.

```js
// New messages
sock.ev.on('messages.upsert', ({ messages, type }) => {
    for (const msg of messages) {
        console.log('Message:', msg.key.id, 'Type:', type);
    }
});

// Message status updates (delivery, read receipts)
sock.ev.on('messages.update', (updates) => {
    for (const update of updates) {
        console.log('Message', update.key.id, 'status:', update.update?.status);
    }
});

// Connection state changes
sock.ev.on('connection.update', (update) => {
    console.log('Connection:', update.connection);
});

// Credential updates (always handle this to persist session)
sock.ev.on('creds.update', saveCreds);

// Presence updates
sock.ev.on('presence.update', ({ id, presences }) => {
    console.log(id, 'is', presences);
});

// Group updates
sock.ev.on('groups.update', (updates) => {
    for (const group of updates) {
        console.log('Group updated:', group.id, group.subject);
    }
});

// Group participants changed
sock.ev.on('group-participants.update', ({ id, participants, action }) => {
    console.log('Group', id, ':', action, participants);
});
```

---

## Sending Messages

### Text Messages

```js
// Simple text
await sock.sendMessage('1234567890@s.whatsapp.net', {
    text: 'Hello from whalib!'
});

// Text with mentions
await sock.sendMessage('group-id@g.us', {
    text: '@User1 @User2 check this out',
    mentions: ['user1@s.whatsapp.net', 'user2@s.whatsapp.net']
});
```

### Images

```js
const fs = require('fs');

// From file buffer
await sock.sendMessage('1234567890@s.whatsapp.net', {
    image: fs.readFileSync('./photo.jpg'),
    caption: 'Check out this photo!',
    mimetype: 'image/jpeg'
});

// From URL
await sock.sendMessage('1234567890@s.whatsapp.net', {
    image: { url: 'https://example.com/photo.jpg' },
    caption: 'Image from URL'
});
```

### Videos

```js
// Video with caption
await sock.sendMessage('1234567890@s.whatsapp.net', {
    video: fs.readFileSync('./video.mp4'),
    caption: 'Watch this!',
    mimetype: 'video/mp4'
});

// GIF (set gifPlayback to true)
await sock.sendMessage('1234567890@s.whatsapp.net', {
    video: fs.readFileSync('./animation.mp4'),
    gifPlayback: true,
    mimetype: 'video/mp4'
});

// PTV (circular video message)
await sock.sendMessage('1234567890@s.whatsapp.net', {
    video: fs.readFileSync('./clip.mp4'),
    ptv: true,
    mimetype: 'video/mp4'
});
```

### Audio and Voice Notes

```js
// Audio file
await sock.sendMessage('1234567890@s.whatsapp.net', {
    audio: fs.readFileSync('./song.mp3'),
    mimetype: 'audio/mpeg'
});

// Voice note (push-to-talk)
await sock.sendMessage('1234567890@s.whatsapp.net', {
    audio: fs.readFileSync('./voice.ogg'),
    mimetype: 'audio/ogg; codecs=opus',
    ptt: true
});
```

### Documents

```js
await sock.sendMessage('1234567890@s.whatsapp.net', {
    document: fs.readFileSync('./report.pdf'),
    mimetype: 'application/pdf',
    fileName: 'Monthly Report.pdf',
    caption: 'Here is the report'
});
```

### Stickers

```js
await sock.sendMessage('1234567890@s.whatsapp.net', {
    sticker: fs.readFileSync('./sticker.webp'),
    mimetype: 'image/webp'
});
```

### Location

```js
await sock.sendMessage('1234567890@s.whatsapp.net', {
    location: {
        degreesLatitude: 48.8584,
        degreesLongitude: 2.2945,
        name: 'Eiffel Tower',
        address: 'Champ de Mars, Paris, France'
    }
});
```

### Contacts

```js
// Single contact
const vcard = `BEGIN:VCARD
VERSION:3.0
FN:John Doe
TEL;type=CELL;type=VOICE:+1234567890
END:VCARD`;

await sock.sendMessage('1234567890@s.whatsapp.net', {
    contacts: {
        displayName: 'John Doe',
        contacts: [{ displayName: 'John Doe', vcard }]
    }
});
```

### Reactions

```js
// React to a message
await sock.sendMessage('1234567890@s.whatsapp.net', {
    react: {
        text: '👍',
        key: message.key  // The key of the message to react to
    }
});

// Remove reaction
await sock.sendMessage('1234567890@s.whatsapp.net', {
    react: {
        text: '',  // Empty string removes the reaction
        key: message.key
    }
});
```

### Polls

```js
await sock.sendMessage('group-id@g.us', {
    poll: {
        name: 'What should we eat?',
        values: ['Pizza', 'Sushi', 'Tacos', 'Burgers'],
        selectableCount: 1  // Single choice (0 or undefined = multiple choice)
    }
});
```

### Buttons and Lists

```js
// Buttons
await sock.sendMessage('1234567890@s.whatsapp.net', {
    buttons: {
        text: 'Choose an option:',
        footer: 'Powered by whalib',
        buttons: [
            { buttonId: 'btn1', displayText: 'Option 1' },
            { buttonId: 'btn2', displayText: 'Option 2' },
            { buttonId: 'btn3', displayText: 'Option 3' }
        ]
    }
});

// List
await sock.sendMessage('1234567890@s.whatsapp.net', {
    listMessage: {
        title: 'Menu',
        description: 'Select from the list below',
        buttonText: 'View Menu',
        footerText: 'whalib',
        sections: [
            {
                title: 'Main Dishes',
                rows: [
                    { title: 'Pizza', description: 'Classic Margherita', rowId: 'pizza' },
                    { title: 'Pasta', description: 'Carbonara', rowId: 'pasta' }
                ]
            },
            {
                title: 'Drinks',
                rows: [
                    { title: 'Water', rowId: 'water' },
                    { title: 'Coffee', rowId: 'coffee' }
                ]
            }
        ]
    }
});
```

### Template Buttons

```js
await sock.sendMessage('1234567890@s.whatsapp.net', {
    templateButtons: {
        text: 'Visit us!',
        footer: 'whalib',
        buttons: [
            { urlButton: { displayText: 'Visit Website', url: 'https://example.com' } },
            { callButton: { displayText: 'Call Us', phoneNumber: '+1234567890' } },
            { quickReplyButton: { displayText: 'Quick Reply', id: 'reply-1' } }
        ]
    }
});
```

### Events

```js
await sock.sendMessage('group-id@g.us', {
    event: {
        name: 'Team Meeting',
        description: 'Weekly sync-up call',
        startDate: new Date('2026-04-01T14:00:00Z'),
        location: 'Conference Room A'
    }
});
```

---

## Replying and Quoting

Quote a message by passing it in the `quoted` option:

```js
sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.key.fromMe && msg.message?.conversation) {
        await sock.sendMessage(msg.key.remoteJid, {
            text: 'Thanks for your message!'
        }, {
            quoted: msg
        });
    }
});
```

---

## Editing Messages

Edit a previously sent message:

```js
const sent = await sock.sendMessage('1234567890@s.whatsapp.net', {
    text: 'Hello!'
});

// Edit it later
await sock.sendMessage('1234567890@s.whatsapp.net', {
    edit: sent.key,
    text: 'Hello! (edited)'
});
```

---

## Deleting Messages

Delete a message for everyone:

```js
await sock.sendMessage('1234567890@s.whatsapp.net', {
    delete: message.key
});
```

---

## Forwarding Messages

Forward a message to another chat:

```js
await sock.sendMessage('9876543210@s.whatsapp.net', {
    forward: originalMessage
});
```

---

## View Once Messages

Send a photo or video that can only be viewed once:

```js
await sock.sendMessage('1234567890@s.whatsapp.net', {
    image: fs.readFileSync('./secret.jpg'),
    caption: 'This will disappear after viewing',
    viewOnce: true
});
```

---

## Disappearing Messages

Enable or disable disappearing messages for a chat:

```js
// Enable (24 hours)
await sock.sendMessage('1234567890@s.whatsapp.net', {
    disappearingMessagesInChat: 86400
});

// Disable
await sock.sendMessage('1234567890@s.whatsapp.net', {
    disappearingMessagesInChat: false
});
```

---

## Media Download

Download media from a received message:

```js
const { downloadMediaMessage } = require('whalib');

sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (msg.message?.imageMessage) {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        fs.writeFileSync('./downloaded.jpg', buffer);
        console.log('Image saved!');
    }
});
```

---

## Presence Updates

Let contacts know when you are typing or recording:

```js
// Show "typing..."
await sock.sendPresenceUpdate('composing', '1234567890@s.whatsapp.net');

// Show "recording audio..."
await sock.sendPresenceUpdate('recording', '1234567890@s.whatsapp.net');

// Clear typing indicator
await sock.sendPresenceUpdate('paused', '1234567890@s.whatsapp.net');

// Set yourself as online/offline
await sock.sendPresenceUpdate('available');
await sock.sendPresenceUpdate('unavailable');
```

---

## Read Receipts

Mark messages as read:

```js
// Mark a single message as read
await sock.sendReceipt(
    '1234567890@s.whatsapp.net',
    undefined,
    ['MESSAGE_ID'],
    'read'
);

// Mark multiple messages as read
await sock.sendReceipt(
    '1234567890@s.whatsapp.net',
    undefined,
    ['MSG_ID_1', 'MSG_ID_2', 'MSG_ID_3'],
    'read'
);

// Mark group message as read (requires participant)
await sock.sendReceipt(
    'group-id@g.us',
    'sender@s.whatsapp.net',
    ['MESSAGE_ID'],
    'read'
);
```

---

## Profile

```js
// Update your display name
await sock.updateProfileName('My Bot');

// Update profile picture (for yourself or a group)
await sock.updateProfilePicture('1234567890@s.whatsapp.net', {
    url: './avatar.jpg'
});

// Check if a phone number is on WhatsApp
const [result] = await sock.onWhatsApp('1234567890');
if (result?.exists) {
    console.log('User is on WhatsApp:', result.jid);
}
```

---

## Group Management

```js
// Create a group
const group = await sock.groupCreate('My Group', [
    '1111111111@s.whatsapp.net',
    '2222222222@s.whatsapp.net'
]);
console.log('Group created:', group.id);

// Update group subject
await sock.groupUpdateSubject(group.id, 'New Group Name');

// Update group description
await sock.groupUpdateDescription(group.id, 'This is our group');

// Add participants
await sock.groupParticipantsUpdate(group.id, [
    '3333333333@s.whatsapp.net'
], 'add');

// Remove participants
await sock.groupParticipantsUpdate(group.id, [
    '3333333333@s.whatsapp.net'
], 'remove');

// Promote to admin
await sock.groupParticipantsUpdate(group.id, [
    '1111111111@s.whatsapp.net'
], 'promote');

// Demote from admin
await sock.groupParticipantsUpdate(group.id, [
    '1111111111@s.whatsapp.net'
], 'demote');

// Get invite code
const code = await sock.groupInviteCode(group.id);
console.log('Invite link: https://chat.whatsapp.com/' + code);

// Revoke invite code
await sock.groupRevokeInvite(group.id);

// Leave group
await sock.groupLeave(group.id);

// Get group metadata
const metadata = await sock.groupMetadata(group.id);
console.log('Members:', metadata.participants.length);
```

---

## WhatsApp IDs (JIDs)

WhatsApp uses JIDs (Jabber IDs) to identify users, groups, and other entities:

| Type | Format | Example |
|------|--------|---------|
| User | `[country code][number]@s.whatsapp.net` | `1234567890@s.whatsapp.net` |
| Group | `[timestamp]-[creator]@g.us` | `120363012345@g.us` |
| Broadcast | `status@broadcast` | `status@broadcast` |
| Newsletter | `[id]@newsletter` | `120363012345@newsletter` |

Utility functions for working with JIDs:

```js
const { jidDecode, jidEncode, jidNormalizedUser, isJidGroup } = require('whalib');

// Decode a JID
const decoded = jidDecode('1234567890:5@s.whatsapp.net');
// { user: '1234567890', device: 5, server: 's.whatsapp.net' }

// Normalize (remove device part)
const normalized = jidNormalizedUser('1234567890:5@s.whatsapp.net');
// '1234567890@s.whatsapp.net'

// Check type
isJidGroup('120363012345@g.us');  // true
```

---

## Socket Configuration

The `makeSocket` function accepts a configuration object:

```js
const sock = makeSocket({
    auth: state,                          // Required. Auth state from useMultiFileAuthState
    browser: Browsers.ubuntu('Chrome'),   // Browser identity
    version: [2, 3000, 1034762614],       // WhatsApp Web version (auto-fetched if omitted)
    logger: pinoLogger,                   // Custom logger (pino recommended)
    connectTimeoutMs: 20000,              // Connection timeout (default: 20s)
    keepAliveIntervalMs: 30000,           // Heartbeat interval (default: 30s)
    defaultQueryTimeoutMs: 60000,         // Query timeout (default: 60s)
    syncFullHistory: false,               // Request full chat history on first connect
    maxMsgRetryCount: 5,                  // Max message retry attempts
    markOnlineOnConnect: true,            // Automatically set presence to online
    fireInitQueries: true,               // Run initialization queries on connect
    emitOwnEvents: true,                 // Emit events for your own sent messages
});
```

### Browser & Platform Configuration

whalib supports a wide range of operating systems and browsers for your WhatsApp Web client identity. You can use any combination — whatever you pass in the `browser` config will be sent to WhatsApp during pairing.

#### OS Presets

Each preset is a function that takes a browser name and returns a `[os, browser, version]` tuple:

```js
const { Browsers } = require('whalib');

// Linux distributions
Browsers.ubuntu('Chrome')      // ['Ubuntu', 'Chrome', '22.04.4']
Browsers.linux('Firefox')      // ['Linux', 'Firefox', '6.5.0']
Browsers.fedora('Firefox')     // ['Fedora', 'Firefox', '39']
Browsers.debian('Chrome')      // ['Debian', 'Chrome', '12.5']
Browsers.arch('Firefox')       // ['Arch', 'Firefox', '2024.03.01']
Browsers.centOS('Chrome')      // ['CentOS', 'Chrome', '9']
Browsers.redHat('Firefox')     // ['Red Hat', 'Firefox', '9.3']
Browsers.mint('Firefox')       // ['Mint', 'Firefox', '21.3']
Browsers.manjaro('Firefox')    // ['Manjaro', 'Firefox', '23.1']
Browsers.kali('Firefox')       // ['Kali', 'Firefox', '2024.1']
Browsers.openSUSE('Chrome')    // ['openSUSE', 'Chrome', '15.5']

// Desktop OS
Browsers.macOS('Safari')       // ['Mac OS', 'Safari', '14.4.1']
Browsers.windows('Edge')       // ['Windows', 'Edge', '10.0.22631']
Browsers.chromeOS('Chrome')    // ['Chrome OS', 'Chrome', '120.0']

// BSD / Unix
Browsers.freeBSD('Firefox')    // ['FreeBSD', 'Firefox', '14.0']
Browsers.openBSD('Firefox')    // ['OpenBSD', 'Firefox', '7.5']
Browsers.solaris('Firefox')    // ['Solaris', 'Firefox', '11.4']
Browsers.aix('Firefox')        // ['AIX', 'Firefox', '7.3']
Browsers.haiku('Epiphany')     // ['Haiku', 'Epiphany', 'R1/beta5']

// Mobile
Browsers.android('Chrome')     // ['Android', 'Chrome', '14.0']
Browsers.iOS('Safari')         // ['iOS', 'Safari', '17.4.1']

// Other
Browsers.tizen('Samsung Internet') // ['Tizen', 'Samsung Internet', '8.0']
Browsers.harmonyOS('Chrome')   // ['HarmonyOS', 'Chrome', '4.0']
Browsers.kaiOS('Firefox')      // ['KaiOS', 'Firefox', '3.1']
Browsers.sailfish('Firefox')   // ['Sailfish', 'Firefox', '4.5']
Browsers.fuchsia('Chrome')     // ['Fuchsia', 'Chrome', '1.0']

// Special
Browsers.whalib('Chrome')      // ['Ubuntu', 'Chrome', '22.04.4'] (library default)
Browsers.appropriate('Chrome')  // Auto-detects your OS and uses its version
```

#### Supported Browsers

Any of these browsers can be passed to any OS preset:

| Browser | Platform Type | Browser | Platform Type |
|---------|--------------|---------|--------------|
| Chrome | Chrome | Brave | Chrome |
| Firefox | Firefox | Vivaldi | Chrome |
| Safari | Safari | Arc | Chrome |
| Edge | Edge | Chromium | Chrome |
| Opera | Opera | Tor | Firefox |
| IE | IE | Waterfox | Firefox |
| DuckDuckGo | Chrome | LibreWolf | Firefox |
| Samsung Internet | Chrome | Pale Moon | Firefox |
| UC Browser | Chrome | Midori | Chrome |
| Yandex | Chrome | Epiphany | Chrome |
| Silk | Chrome | Konqueror | Chrome |
| Maxthon | Chrome | Falkon | Chrome |
| Whale | Chrome | Lynx | Chrome |
| Orion | Safari | Ungoogled Chromium | Chrome |

#### Custom Browser Identity

You can create a fully custom browser identity:

```js
const { Browsers } = require('whalib');

// Using Browsers.custom(osName, browserName, osVersion)
const sock = makeSocket({
    auth: state,
    browser: Browsers.custom('Gentoo', 'Brave', '2024.01')
});
```

#### Auto-Detect Platform

Use `Browsers.appropriate()` to automatically detect your OS:

```js
const sock = makeSocket({
    auth: state,
    browser: Browsers.appropriate('Chrome')  // Detects your OS automatically
});
```

#### Helper Functions

```js
const {
    getPlatformId,
    getBrowserVersion,
    getOSVersion,
    listSupportedBrowsers,
    listSupportedPlatforms
} = require('whalib');

getPlatformId('Firefox')         // '2' — WhatsApp platform type ID
getBrowserVersion('Chrome')      // '131.0.6778.86'
getOSVersion('Ubuntu')           // '22.04.4'
listSupportedBrowsers()          // ['Chrome', 'Firefox', 'Safari', ...]
listSupportedPlatforms()         // ['Ubuntu', 'Linux', 'Mac OS', ...]
```

---

## Events Reference

| Event | Payload | Description |
|-------|---------|-------------|
| `connection.update` | `{ connection, qr, lastDisconnect }` | Connection state changes |
| `creds.update` | `Partial<AuthenticationCreds>` | Credentials updated (must save) |
| `messages.upsert` | `{ messages, type }` | New messages received or sent |
| `messages.update` | `MessageUpdate[]` | Message status changes |
| `presence.update` | `{ id, presences }` | Contact presence updates |
| `groups.upsert` | `GroupMetadata[]` | New groups added |
| `groups.update` | `Partial<GroupMetadata>[]` | Group info changed |
| `group-participants.update` | `{ id, participants, action }` | Group members changed |
| `messaging-history.set` | `{ chats, contacts, messages }` | History sync data |
| `call` | `WACallEvent[]` | Incoming/outgoing calls |

---

## Error Handling and Reconnection

whalib provides disconnect reason codes to help you decide whether to reconnect:

```js
const { makeSocket, useMultiFileAuthState, DISCONNECT_REASON, Browsers } = require('whalib');

async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_session');

    const sock = makeSocket({
        auth: state,
        browser: Browsers.ubuntu('Chrome')
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.statusCode
                || lastDisconnect?.error?.output?.statusCode;
            const reason = lastDisconnect?.error?.message || 'Unknown';

            console.log(`Disconnected: ${reason} (code: ${statusCode})`);

            if (statusCode === DISCONNECT_REASON.loggedOut) {
                console.log('Session expired. Please re-authenticate.');
            } else if (statusCode === DISCONNECT_REASON.restartRequired) {
                console.log('Restart required. Reconnecting...');
                setTimeout(connect, 1000);
            } else {
                console.log('Reconnecting in 3 seconds...');
                setTimeout(connect, 3000);
            }
        }

        if (connection === 'open') {
            console.log('Connected!');
        }
    });
}

connect();
```

---

## Full Example: Echo Bot

A complete example that echoes back any text message it receives:

```js
const { makeSocket, useMultiFileAuthState, Browsers } = require('whalib');
const qrcode = require('qrcode-terminal');

async function startEchoBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./echo_bot_session');

    const sock = makeSocket({
        auth: state,
        browser: Browsers.ubuntu('Chrome')
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        if (update.qr) {
            qrcode.generate(update.qr, { small: true });
        }
        if (update.connection === 'open') {
            console.log('Echo bot is online!');
        }
        if (update.connection === 'close') {
            console.log('Disconnected. Reconnecting...');
            setTimeout(startEchoBot, 3000);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (msg.key.fromMe) continue;

            const text = msg.message?.conversation
                || msg.message?.extendedTextMessage?.text;

            if (text) {
                await sock.sendMessage(msg.key.remoteJid, {
                    text: `Echo: ${text}`
                }, {
                    quoted: msg
                });
            }
        }
    });
}

startEchoBot();
```

---

## Disclaimer

This project is not affiliated with, associated with, endorsed by, or in any way officially connected with WhatsApp or any of its subsidiaries or affiliates. The official WhatsApp website can be found at https://whatsapp.com. "WhatsApp" and related names, marks, emblems and images are registered trademarks of their respective owners. Use at your own risk.

---

## License

MIT License - see [LICENSE](LICENSE) for details.
