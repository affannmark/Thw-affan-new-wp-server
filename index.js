/* ==========================================================================
   AFFAN MARK - ULTIMATE WHATSAPP AUTOMATION BACKEND SERVER
   100% Working, Non-Stop Infinite Loop, Auto-Reconnect & SQLite Persistence
========================================================================== */

import express from 'express';
import fs from 'fs';
import chalk from 'chalk';
import makeWASocket, {
  useMultiFileAuthState,
  Browsers,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ==========================================================================
   DATABASE CONFIGURATION & TABLES
========================================================================== */

const dbPath = path.join(__dirname, 'automation.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error(chalk.red('Database connection error:'), err.message);
  } else {
    console.log(chalk.green('Connected to SQLite database successfully [AFFAN MARK].'));
  }
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      phone TEXT,
      isConnected INTEGER DEFAULT 0,
      sentCount INTEGER DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messageQueue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT,
      target TEXT,
      prefix TEXT,
      message TEXT,
      speed INTEGER,
      isActive INTEGER DEFAULT 1,
      sentCount INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sentLogs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT,
      target TEXT,
      message TEXT,
      sentAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

/* ==========================================================================
   GLOBAL STATES & MANAGERS
================================ */

const sockets = {};
const pairingCodes = {};
const queueTimers = {};
const queueProcessing = {};
const connectingSessions = {};
const activeLoopState = {};
const connectionStatus = {};

function cleanPhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

/* ==========================================================================
   WHATSAPP CORE CONNECTION & SOCKET MANAGER
================================ */

async function connectWA(phone, sessionId) {
  if (connectingSessions[sessionId]) {
    return sockets[sessionId];
  }

  connectingSessions[sessionId] = true;

  try {
    const sessionPath = path.join(__dirname, 'sessions', sessionId);
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const socket = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      browser: Browsers.windows('Chrome'),
      auth: state,
      printQRInTerminal: false,
      markOnlineOnConnect: true,
      keepAliveIntervalMs: 25000,
      connectTimeoutMs: 60000
    });

    sockets[sessionId] = socket;

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', async (update) => {
      const { connection } = update;

      if (connection === 'open') {
        console.log(chalk.green(`[${sessionId}] WhatsApp Connected Successfully [AFFAN MARK]!`));
        connectionStatus[sessionId] = 'connected';

        db.run(
          `INSERT OR REPLACE INTO sessions (id, phone, isConnected, sentCount) VALUES (?, ?, 1, 0)`,
          [sessionId, phone]
        );

        delete pairingCodes[sessionId];
        delete connectingSessions[sessionId];

        processQueue(sessionId);
      }

      if (connection === 'close') {
        console.log(chalk.red(`[${sessionId}] Connection closed. Reconnecting automatically...`));
        connectionStatus[sessionId] = 'disconnected';

        db.run(`UPDATE sessions SET isConnected = 0 WHERE id = ?`, [sessionId]);

        delete sockets[sessionId];
        delete connectingSessions[sessionId];

        if (queueTimers[sessionId]) {
          clearTimeout(queueTimers[sessionId]);
          delete queueTimers[sessionId];
        }

        queueProcessing[sessionId] = false;

        setTimeout(() => {
          connectWA(phone, sessionId).catch(error => {
            console.log(chalk.red(`[${sessionId}] Reconnection failed:`), error.message);
          });
        }, 4000);
      }
    });

    if (!state.creds.registered) {
      const number = cleanPhone(phone);
      if (!number) {
        pairingCodes[sessionId] = { error: 'Invalid phone number provided' };
      } else {
        setTimeout(async () => {
          try {
            const code = await socket.requestPairingCode(number);
            pairingCodes[sessionId] = code;
            console.log(chalk.green(`PAIRING CODE FOR [${sessionId}]: ${code}`));
          } catch (error) {
            pairingCodes[sessionId] = { error: error.message };
          }
        }, 3000);
      }
    }

    return socket;
  } catch (error) {
    delete connectingSessions[sessionId];
    throw error;
  }
}

/* ==========================================================================
   API ENDPOINTS
================================ */

app.post('/api/login', async (req, res) => {
  try {
    const phone = cleanPhone(req.body.phone);
    if (!phone) return res.json({ success: false, message: 'Phone number is required.' });

    const sessionId = `session_${phone}`;
    connectionStatus[sessionId] = 'connecting';

    await connectWA(phone, sessionId);
    res.json({ success: true, sessionId, message: 'Pairing code is being generated.' });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.get('/api/pairing-code/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  const code = pairingCodes[sessionId];
  const status = connectionStatus[sessionId];

  if (status === 'connected') return res.json({ success: true, status: 'connected' });
  if (!code) return res.json({ success: false, status: 'waiting' });
  if (typeof code === 'object' && code.error) return res.json({ success: false, status: 'error', message: code.error });

  res.json({ success: true, status: 'ready', pairingCode: code });
});

app.post('/api/start-automation', (req, res) => {
  const { sessionId, target, prefix = '', messages = [], speed = 3 } = req.body;

  if (!sessionId || !target || !Array.isArray(messages) || messages.length === 0) {
    return res.json({ success: false, message: 'Missing automation fields or empty messages array.' });
  }

  const pending = messages.filter(msg => String(msg).trim());
  if (pending.length === 0) return res.json({ success: false, message: 'No valid text messages found.' });

  const delaySeconds = Math.max(1, Number(speed) || 3);

  db.run(`DELETE FROM messageQueue WHERE sessionId = ?`, [sessionId], () => {
    pending.forEach(message => {
      db.run(
        `INSERT INTO messageQueue (sessionId, target, prefix, message, speed, isActive, sentCount) VALUES (?, ?, ?, ?, ?, 1, 0)`,
        [sessionId, String(target).trim(), prefix, String(message), delaySeconds]
      );
    });

    activeLoopState[sessionId] = true;
    processQueue(sessionId);
  });

  res.json({ success: true, message: `${pending.length} message(s) loaded successfully for non-stop infinite loop [AFFAN MARK].` });
});

app.post('/api/stop-automation', (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.json({ success: false, message: 'Session ID is required.' });

  activeLoopState[sessionId] = false;
  db.run(`UPDATE messageQueue SET isActive = 0 WHERE sessionId = ?`, [sessionId]);

  if (queueTimers[sessionId]) {
    clearTimeout(queueTimers[sessionId]);
    delete queueTimers[sessionId];
  }

  queueProcessing[sessionId] = false;
  res.json({ success: true, message: 'Automation stopped successfully [AFFAN MARK].' });
});

/* ==========================================================================
   QUEUE PROCESSOR & NON-STOP INFINITE LOOP ENGINE
================================ */

async function processQueue(sessionId) {
  if (queueProcessing[sessionId] || activeLoopState[sessionId] === false) return;
  queueProcessing[sessionId] = true;

  try {
    const socket = sockets[sessionId];
    if (!socket) {
      queueProcessing[sessionId] = false;
      return;
    }

    db.get(
      `SELECT * FROM messageQueue WHERE sessionId = ? AND isActive = 1 ORDER BY id ASC LIMIT 1`,
      [sessionId],
      async (error, item) => {
        if (error) {
          queueProcessing[sessionId] = false;
          return;
        }

        // NON-STOP INFINITE LOOP: RESTART FROM START AUTOMATICALLY
        if (!item) {
          if (activeLoopState[sessionId] !== false) {
            db.run(`UPDATE messageQueue SET isActive = 1 WHERE sessionId = ?`, [sessionId], () => {
              queueProcessing[sessionId] = false;
              processQueue(sessionId);
            });
          } else {
            queueProcessing[sessionId] = false;
          }
          return;
        }

        try {
          const target = String(item.target || '').trim();
          if (!target) {
            db.run(`UPDATE messageQueue SET isActive = 0 WHERE id = ?`, [item.id], () => {
              queueProcessing[sessionId] = false;
              processQueue(sessionId);
            });
            return;
          }

          const chatId = target.endsWith('@g.us') ? target : `${cleanPhone(target)}@s.whatsapp.net`;
          const fullMsg = `${item.prefix || ''} ${item.message}`.trim();

          await socket.sendMessage(chatId, { text: fullMsg });

          db.run(`INSERT INTO sentLogs (sessionId, target, message) VALUES (?, ?, ?)`, [sessionId, target, fullMsg]);
          db.run(`UPDATE sessions SET sentCount = sentCount + 1 WHERE id = ?`, [sessionId]);

          db.run(`UPDATE messageQueue SET isActive = 0 WHERE id = ?`, [item.id], () => {
            queueProcessing[sessionId] = false;
            if (activeLoopState[sessionId] === false) return;

            const delayMs = Math.max(1, Number(item.speed) || 3) * 1000;
            queueTimers[sessionId] = setTimeout(() => {
              delete queueTimers[sessionId];
              processQueue(sessionId);
            }, delayMs);
          });
        } catch (error) {
          db.run(`UPDATE messageQueue SET isActive = 0 WHERE id = ?`, [item.id], () => {
            queueProcessing[sessionId] = false;
            queueTimers[sessionId] = setTimeout(() => processQueue(sessionId), 1500);
          });
        }
      }
    );
  } catch (error) {
    queueProcessing[sessionId] = false;
  }
}

app.get('/api/groups/:sessionId', async (req, res) => {
  try {
    const socket = sockets[req.params.sessionId];
    if (!socket) return res.json({ success: false, message: 'WhatsApp session is not active.' });

    const groups = await socket.groupFetchAllParticipating();
    const groupList = Object.values(groups || {}).map(g => ({ id: g.id, subject: g.subject || 'Unnamed Group' }));
    res.json({ success: true, groups: groupList });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.get('/api/logs/:sessionId', (req, res) => {
  db.all(`SELECT * FROM sentLogs WHERE sessionId = ? ORDER BY id DESC LIMIT 15`, [req.params.sessionId], (error, rows) => {
    res.json({ success: true, logs: rows || [] });
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(chalk.green(`==================================================`));
  console.log(chalk.green(`       TOOL OWNER: AFFAN MARK                     `));
  console.log(chalk.green(`       WHATSAPP AUTOMATION SERVER ONLINE          `));
  console.log(chalk.green(`       PORT: ${PORT}                              `));
  console.log(chalk.green(`==================================================`));
});

/* ==========================================================================
   SELF-KEEP-ALIVE PING (PREVENTS RENDER SLEEP ALONG WITH UPTIMEROBOT)
================================ */
setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  http.get(url, () => {}).on('error', () => {});
}, 300000);
