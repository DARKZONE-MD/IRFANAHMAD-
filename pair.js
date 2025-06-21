const express = require('express');
const fs = require('fs');
const { exec } = require('child_process');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  makeCacheableSignalKeyStore,
  Browsers,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');
const { upload } = require('./mega');

const router = express.Router();

function removeFile(path) {
  if (fs.existsSync(path)) {
    fs.rmSync(path, { recursive: true, force: true });
  }
}

function randomMegaId(length = 6, numberLength = 4) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  const number = Math.floor(Math.random() * Math.pow(10, numberLength));
  return `${result}${number}`;
}

router.get('/', async (req, res) => {
  const number = (req.query.number || '').replace(/[^0-9]/g, '');

  if (!number || number.length < 10) {
    return res.status(400).send({ code: 'Invalid or missing number' });
  }

  try {
    const { state, saveCreds } = await useMultiFileAuthState('./session');

    const socket = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
      },
      logger: pino({ level: 'silent' }),
      browser: Browsers.macOS('Safari'),
      printQRInTerminal: false,
    });

    if (!socket.authState.creds.registered) {
      await delay(1000);
      const code = await socket.requestPairingCode(number);
      res.send({ code });

      // Attach listeners only after sending response
      socket.ev.on('creds.update', saveCreds);

      socket.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
        if (connection === 'open') {
          try {
            await delay(10000); // allow creds to finalize

            const authPath = './session/';
            const user_jid = jidNormalizedUser(socket.user.id);
            const stream = fs.createReadStream(`${authPath}creds.json`);

            const mega_url = await upload(stream, `${randomMegaId()}.json`);
            const sessionId = mega_url.replace('https://mega.nz/file/', '');

            await socket.sendMessage(user_jid, { text: sessionId });

            await delay(100);
            removeFile(authPath);
          } catch (err) {
            console.error('Message sending/upload failed:', err.message);
            exec('pm2 restart prabath');
          }
        } else if (
          connection === 'close' &&
          lastDisconnect?.error?.output?.statusCode !== 401
        ) {
          console.log('Reconnecting...');
          exec('pm2 restart prabath');
        }
      });
    } else {
      res.send({ code: 'Already registered' });
    }
  } catch (error) {
    console.error('Fatal error:', error.message);
    removeFile('./session');
    if (!res.headersSent) {
      res.status(500).send({ code: 'Service Unavailable' });
    }
  }
});

// Safety fallback
process.on('uncaughtException', function (err) {
  console.error('Caught uncaughtException:', err);
  exec('pm2 restart prabath');
});

module.exports = router;
