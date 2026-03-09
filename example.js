'use strict';

const { makeSocket, useMultiFileAuthState, DISCONNECT_REASON } = require('./index');

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_session');

    const sock = makeSocket({
        auth: state,
        browser: ['Ubuntu', 'Chrome', '22.04.4'],
        logger: {
            level: 'info',
            info: (...args) => console.log('[INFO]', ...args),
            warn: (...args) => console.warn('[WARN]', ...args),
            error: (...args) => console.error('[ERROR]', ...args),
            debug: () => {},
            trace: () => {}
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n--- Scan this QR code with WhatsApp ---');
            try {
                const qrcodeTerminal = require('qrcode-terminal');
                qrcodeTerminal.generate(qr, { small: true });
            } catch {
                console.log('QR data:', qr);
            }
            console.log('---------------------------------------\n');
        }

        if (connection === 'open') {
            console.log('Connected to WhatsApp!');
            console.log('User:', sock.user);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.statusCode;
            const shouldReconnect = statusCode !== DISCONNECT_REASON.loggedOut;

            console.log('Connection closed:', lastDisconnect?.error?.message);

            if (shouldReconnect) {
                console.log('Reconnecting in 3 seconds...');
                setTimeout(() => startBot(), 3000);
            } else {
                console.log('Logged out. Delete auth_session folder and restart.');
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const msg of messages) {
            const from = msg.key.remoteJid;
            const isFromMe = msg.key.fromMe;
            const pushName = msg.pushName || '';

            if (isFromMe) continue;

            const text = msg.message?.conversation ||
                        msg.message?.extendedTextMessage?.text ||
                        '';

            if (!text) continue;

            console.log('[' + pushName + '] ' + from + ': ' + text);

            if (text.startsWith('!echo ')) {
                const reply = text.slice(6);
                await sock.sendTextMessage(from, reply);
                console.log('Replied to ' + from + ': ' + reply);
            }

            if (text === '!ping') {
                await sock.sendTextMessage(from, 'pong!');
                console.log('Replied to ' + from + ': pong!');
            }

            await sock.readMessages([msg.key]);
        }
    });

    sock.ev.on('messages.update', (updates) => {
        for (const update of updates) {
            const statusText = {
                2: 'sent',
                3: 'delivered',
                4: 'read',
                5: 'played'
            };
            console.log(
                'Message ' + update.key.id + ' status:',
                statusText[update.update.status] || update.update.status
            );
        }
    });
}

startBot().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
