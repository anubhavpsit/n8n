// WhatsApp Web automation service (Playwright + Express)
// Endpoints:
//   GET  /status          -> { loggedIn: true/false }
//   GET  /qr?key=SECRET   -> page showing the login QR (auto-refreshes)
//   POST /send            -> body { number: "919876543210", message: "Hi" }
//
// Optional env:  API_KEY (falls back to the default below)
// Optional env:  PORT (3000), HOST (0.0.0.0), SESSION_DIR (./session)

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 3000;
// Use 127.0.0.1 if n8n runs on the same machine (not in Docker) so the
// server is not reachable from outside.
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_DIR = process.env.SESSION_DIR || path.join(__dirname, 'session');
// Uses the API_KEY env var if set, otherwise this default (same as n8n's waApiKey)
const API_KEY = process.env.API_KEY || 'a3f9c2e17b4d8e05f6a1c9b2d3e4f5a6'; // <-- change this

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// Selectors (WhatsApp changes these occasionally - update here if it breaks)
const CHAT_LIST = '#pane-side, [aria-label="Chat list"]';
const COMPOSE_BOX = 'footer div[contenteditable="true"]';
const QR_CANVAS = 'canvas';
const PENDING_ICON = '[data-icon="msg-time"]';
const INVALID_NUMBER_TEXT = /phone number shared via url is invalid/i; // English UI only

let context;
let page;
let queue = Promise.resolve();
let shuttingDown = false;

// Run one browser task at a time (there is only one WhatsApp tab)
function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomBetween = (min, max) => min + Math.floor(Math.random() * (max - min));

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Exit on browser failure; pm2/systemd restarts the process with the saved session.
function fatal(reason) {
  if (shuttingDown) return;
  console.error(`Fatal: ${reason}. Exiting so the process manager can restart.`);
  process.exit(1);
}

async function init() {
  context = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: false,
    userAgent: UA,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  context.on('close', () => fatal('browser context closed'));

  page = context.pages()[0] || (await context.newPage());
  page.on('crash', () => fatal('page crashed'));
  page.on('close', () => fatal('page closed'));

  await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' });
  console.log('WhatsApp Web opened. Visit /qr?key=YOUR_KEY to log in if needed.');
}

async function isLoggedIn(waitMs = 0) {
  if (waitMs > 0) {
    await page.locator(CHAT_LIST).first().waitFor({ timeout: waitMs }).catch(() => {});
  }
  return (await page.locator(CHAT_LIST).count()) > 0;
}

async function sendMessage(number, message) {
  if (!(await isLoggedIn(30000))) throw httpError('NOT_LOGGED_IN', 503);

  const url =
    `https://web.whatsapp.com/send?phone=${number}` +
    `&text=${encodeURIComponent(message)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  const box = page.locator(COMPOSE_BOX);
  const invalid = page.getByText(INVALID_NUMBER_TEXT);

  try {
    await box.or(invalid).first().waitFor({ timeout: 60000 });
  } catch {
    throw httpError('CHAT_LOAD_TIMEOUT', 504);
  }

  if (await invalid.isVisible()) throw httpError('INVALID_NUMBER', 400);

  // Make sure the ?text= prefill has actually landed in the compose box,
  // otherwise Enter would do nothing (or send an empty message).
  try {
    await page.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        return el && el.innerText.trim().length > 0;
      },
      COMPOSE_BOX,
      { timeout: 15000 }
    );
  } catch {
    throw httpError('MESSAGE_NOT_PREFILLED', 500);
  }

  await sleep(randomBetween(1500, 3500)); // look human
  await box.press('Enter');

  // Confirm delivery to WhatsApp's server: the clock icon appears while the
  // message is pending and disappears once it is sent (single tick).
  const pending = page.locator(PENDING_ICON).last();
  await pending.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  try {
    await pending.waitFor({ state: 'hidden', timeout: 30000 });
  } catch {
    throw httpError('SEND_NOT_CONFIRMED', 504);
  }

  // Compose box should be empty again after a successful send.
  const leftover = (await box.innerText().catch(() => '')).trim();
  if (leftover.length > 0) throw httpError('SEND_NOT_CONFIRMED', 504);

  await sleep(1000);
}

const app = express();
app.use(express.json({ limit: '100kb' }));

// API-key check (header x-api-key or ?key=), timing-safe comparison
const keyBuf = Buffer.from(API_KEY);
app.use((req, res, next) => {
  const key = Buffer.from(String(req.get('x-api-key') || req.query.key || ''));
  if (key.length !== keyBuf.length || !crypto.timingSafeEqual(key, keyBuf)) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
  next();
});

app.get('/status', async (req, res) => {
  try {
    const loggedIn = await enqueue(() => isLoggedIn(5000));
    res.json({ loggedIn });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/qr', (req, res) => {
  const key = encodeURIComponent(req.query.key || '');
  res.send(`<!doctype html><html><head><meta http-equiv="refresh" content="8">
<title>WhatsApp Login</title></head>
<body style="font-family:sans-serif;text-align:center;padding:30px">
<h2>Scan with WhatsApp &rarr; Linked Devices</h2>
<img src="/qr.png?key=${key}&t=${Date.now()}" style="width:300px;background:#fff;padding:10px"/>
<p>This page refreshes every 8 seconds. Check <a href="/status?key=${key}">/status</a> after scanning.</p>
</body></html>`);
});

app.get('/qr.png', async (req, res) => {
  try {
    const png = await enqueue(async () => {
      if (await isLoggedIn()) return null;
      const canvas = page.locator(QR_CANVAS).first();
      await canvas.waitFor({ timeout: 20000 });
      return canvas.screenshot();
    });
    if (!png) return res.status(200).send('Already logged in');
    res.type('png').send(png);
  } catch (e) {
    res.status(500).send('QR not available yet, refresh in a few seconds');
  }
});

app.post('/send', async (req, res) => {
  const number = String(req.body.number || '').replace(/\D/g, '');
  const message = String(req.body.message || '');
  if (number.length < 11 || number.length > 15 || !message.trim()) {
    return res
      .status(400)
      .json({ ok: false, number, error: 'number (with country code) and message are required' });
  }
  try {
    await enqueue(() => sendMessage(number, message));
    console.log(`Sent to ${number}`);
    res.json({ ok: true, number });
  } catch (e) {
    console.error(`Failed for ${number}: ${e.message}`);
    res.status(e.status || 500).json({ ok: false, number, error: e.message });
  }
});

let server;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, closing browser so the session is saved cleanly...`);
  server?.close();
  try {
    await Promise.race([context?.close(), sleep(10000)]);
  } catch {}
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

init()
  .then(() => {
    server = app.listen(PORT, HOST, () => console.log(`wa-bot listening on ${HOST}:${PORT}`));
  })
  .catch((e) => {
    console.error('Failed to start browser:', e);
    process.exit(1);
  });