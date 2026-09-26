// Facebook posting via browser automation (Playwright + Express)
// Endpoints (all need x-api-key header or ?key=):
//   GET  /status      -> { loggedIn: true/false }
//   GET  /screen.png  -> screenshot of what the hidden browser sees (debugging)
//   POST /cookies     -> import cookies exported from your normal browser (login option B)
//   POST /post        -> body { message, image, target_url }
//        image      = optional local file path OR public http(s) URL
//        target_url = optional; defaults to your home feed. Use a group URL to post in a group.

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 3001;
const SESSION_DIR = process.env.SESSION_DIR || path.join(__dirname, 'session');
// const API_KEY = process.env.API_KEY || 'change-me-secret'; // <-- change this
// const HEADLESS = process.env.HEADLESS !== 'false';
const API_KEY = process.env.API_KEY || 'a3f9c2e17b4d8e05f6a1c9b2d3e4f5a6'; // <-- change this
const HEADLESS = false; // Show the browser if this is set to true browser will be hidden
const HOME_URL = 'https://www.facebook.com/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// Selectors / texts (assume Facebook UI language = English). Update here if Facebook changes.
const COMPOSER_TRIGGER = /what.s on your mind|write something/i; // the clickable box, NOT the 'Create a post' heading
const TEXTBOX = [
  '[contenteditable="true"][aria-label*="mind" i]',
  '[contenteditable="true"][aria-placeholder*="mind" i]',
  '[contenteditable="true"][aria-label*="write something" i]',
  '[contenteditable="true"][aria-placeholder*="write something" i]',
  '[contenteditable="true"][aria-label*="create a public post" i]',
  '[role="dialog"] [contenteditable="true"][role="textbox"]',
].join(', ');
const PHOTO_BUTTON = /photo\/video/i;
const ADD_PHOTOS_TEXT = /add photos\/videos/i;

let context;
let page;
let queue = Promise.resolve();
let lastErrorPng = null; // screenshot taken automatically when a post fails

function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.floor(Math.random() * (max - min));
function httpErr(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

async function init() {
  context = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: HEADLESS,
    userAgent: UA,
    locale: 'en-US',
    viewport: { width: 1366, height: 900 },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-notifications'],
  });
  page = context.pages()[0] || (await context.newPage());
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
  console.log(
    HEADLESS
      ? 'Running headless.'
      : 'Browser window is open: log in to Facebook there. When done, press Ctrl+C and start with pm2.'
  );
}

async function hasSessionCookie() {
  // Facebook sets c_user only while an account is logged in; logout removes it
  const cookies = await context.cookies('https://www.facebook.com');
  return cookies.some((c) => c.name === 'c_user' && c.value);
}

async function onLoginWall() {
  const url = page.url();
  if (/\/login|checkpoint|two_step|recover/i.test(url)) return true;
  if (!(await hasSessionCookie())) return true;
  // Login form or "Recent logins / Continue as ..." screen
  const loginUi = page.locator('input[name="email"], input[name="pass"], input[type="password"], form[action*="login"]');
  return (await loginUi.count()) > 0;
}

async function isLoggedIn() {
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  return !(await onLoginWall());
}

async function getImageFile(image) {
  if (!image) return null;
  if (/^https?:\/\//i.test(image)) {
    const res = await fetch(image);
    if (!res.ok) throw httpErr(400, `IMAGE_DOWNLOAD_FAILED (${res.status})`);
    const type = res.headers.get('content-type') || '';
    const ext = type.includes('png') ? '.png' : type.includes('webp') ? '.webp' : '.jpg';
    const file = path.join(os.tmpdir(), `fbpost-${Date.now()}${ext}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return { file, temp: true };
  }
  if (!fs.existsSync(image)) throw httpErr(400, `IMAGE_NOT_FOUND: ${image}`);
  return { file: image, temp: false };
}

async function attachImage(dialog, file) {
  const input = dialog.locator('input[type="file"]');
  if ((await input.count()) === 0) {
    await dialog
      .getByRole('button', { name: PHOTO_BUTTON })
      .or(dialog.getByLabel(PHOTO_BUTTON))
      .first()
      .click({ timeout: 15000 });
    await sleep(1500);
  }
  if ((await input.count()) > 0) {
    await input.first().setInputFiles(file);
    return;
  }
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15000 }),
    dialog.getByText(ADD_PHOTOS_TEXT).first().click(),
  ]);
  await chooser.setFiles(file);
}

async function clickPost() {
  const deadline = Date.now() + 90000; // photo uploads can take a while
  while (Date.now() < deadline) {
    const d = (await page.getByRole('dialog').count()) > 0 ? page.getByRole('dialog').last() : page;
    const post = d.getByRole('button', { name: /^post$/i }).first();
    const next = d.getByRole('button', { name: /^next$/i }).first();
    if ((await post.isVisible().catch(() => false)) && (await post.getAttribute('aria-disabled')) !== 'true') {
      await sleep(rand(800, 2000));
      await post.click();
      return;
    }
    if ((await next.isVisible().catch(() => false)) && (await next.getAttribute('aria-disabled')) !== 'true') {
      await next.click();
      await sleep(2500);
      continue;
    }
    await sleep(1000);
  }
  throw httpErr(500, 'POST_BUTTON_NOT_READY');
}

async function openComposer() {
  // Try the real button first, then its inner text. Wait up to 20s for the feed to render.
  const candidates = [
    page.getByRole('button', { name: COMPOSER_TRIGGER }),
    page.locator('[role="button"]').filter({ hasText: COMPOSER_TRIGGER }),
    page.getByText(COMPOSER_TRIGGER),
  ];
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    for (const loc of candidates) {
      const el = loc.first();
      if (await el.isVisible().catch(() => false)) {
        // Put it in the middle of the screen so the sticky top bar can't cover it
        await el.evaluate((n) => n.scrollIntoView({ block: 'center' }));
        await sleep(rand(700, 1300));
        await el.click({ timeout: 10000 });
        return;
      }
    }
    await sleep(1000);
  }
  throw httpErr(500, 'COMPOSER_NOT_FOUND (check /screen.png)');
}

async function createPost({ message, image, target_url }) {
  const img = await getImageFile(image);
  try {
    await page.goto(target_url || HOME_URL, { waitUntil: 'domcontentloaded' });
    await sleep(rand(3000, 6000));
    if (await onLoginWall()) throw httpErr(503, 'NOT_LOGGED_IN');

    await page.mouse.wheel(0, rand(100, 300)); // small human-like scroll
    await sleep(rand(800, 1500));
    await page.mouse.wheel(0, -500);

    await openComposer();

    // Wait for the post text box to appear (inside a dialog or not)
    const box = page.locator(TEXTBOX).locator('visible=true').first();
    try {
      await box.waitFor({ state: 'visible', timeout: 30000 });
    } catch {
      throw httpErr(500, 'POST_BOX_NOT_FOUND (see /last-error.png)');
    }
    const dialogWithBox = page.getByRole('dialog').filter({ has: page.locator(TEXTBOX) }).last();
    const dialog = (await dialogWithBox.count()) > 0 ? dialogWithBox : page;
    await box.click();
    await sleep(rand(800, 1500));
    if (message) await page.keyboard.type(message, { delay: rand(25, 60) });
    await sleep(rand(1000, 2000));

    if (img) {
      await attachImage(dialog, img.file);
      await sleep(rand(4000, 7000));
    }

    await clickPost();

    // Wait for the composer to close = post submitted
    try {
      await page.locator(TEXTBOX).locator('visible=true').first().waitFor({ state: 'hidden', timeout: 60000 });
    } catch {
      throw httpErr(500, 'POST_MAYBE_FAILED (composer still open - see /last-error.png)');
    }
    await sleep(3000);
  } catch (e) {
    lastErrorPng = await page.screenshot().catch(() => null);
    throw e;
  } finally {
    if (img && img.temp) fs.unlink(img.file, () => {});
  }
}

const app = express();
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  const key = req.get('x-api-key') || req.query.key;
  if (key !== API_KEY) return res.status(401).json({ error: 'UNAUTHORIZED' });
  next();
});

app.get('/status', async (req, res) => {
  try {
    const result = await enqueue(async () => ({
      loggedIn: await isLoggedIn(),
      hasSessionCookie: await hasSessionCookie(),
      url: page.url(),
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/screen.png', async (req, res) => {
  try {
    res.type('png').send(await enqueue(() => page.screenshot()));
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get('/last-error.png', (req, res) => {
  if (!lastErrorPng) return res.status(404).send('No failed post yet');
  res.type('png').send(lastErrorPng);
});

app.post('/cookies', async (req, res) => {
  const list = Array.isArray(req.body) ? req.body : req.body.cookies;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'Send the exported cookie JSON array' });
  const sameSiteMap = { no_restriction: 'None', lax: 'Lax', strict: 'Strict', None: 'None', Lax: 'Lax', Strict: 'Strict' };
  const cookies = list
    .filter((c) => c.name && c.domain)
    .map((c) => ({
      name: c.name,
      value: String(c.value ?? ''),
      domain: c.domain,
      path: c.path || '/',
      expires: c.expirationDate ? Math.floor(c.expirationDate) : typeof c.expires === 'number' ? c.expires : -1,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite: sameSiteMap[c.sameSite] || 'Lax',
    }));
  try {
    await enqueue(() => context.addCookies(cookies));
    const loggedIn = await enqueue(isLoggedIn);
    res.json({ imported: cookies.length, loggedIn });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/post', async (req, res) => {
  const message = String(req.body.message || '').trim();
  const image = String(req.body.image || '').trim();
  const target_url = String(req.body.target_url || '').trim();
  if (!message && !image) return res.status(400).json({ ok: false, error: 'message or image is required' });
  try {
    await enqueue(() => createPost({ message, image, target_url }));
    console.log(`Posted: ${message.slice(0, 50)}`);
    res.json({ ok: true });
  } catch (e) {
    console.error(`Post failed: ${e.message}`);
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

init()
  .then(() => app.listen(PORT, () => console.log(`fb-bot listening on ${PORT}`)))
  .catch((e) => {
    console.error('Failed to start browser:', e);
    process.exit(1);
  });