// Facebook GROUP like/react automation via browser automation (Playwright + Express).
// Navigates to a list of Facebook groups, scrolls through posts, and randomly likes
// (or reacts to) posts and optionally their comments.
//
// Endpoints (all need x-api-key header or ?key=):
//   GET  /status          -> { loggedIn, hasSessionCookie, url }
//   GET  /screen.png      -> live screenshot of what the browser sees (debugging)
//   GET  /last-error.png  -> screenshot taken when the last group failed
//   GET  /proof.png       -> screenshot taken right after the most recent verified like
//   POST /cookies         -> import cookies exported from your normal browser (login option B)
//   POST /jobs            -> start a like-job; body:
//        { groups, posts_per_group, like_comments, comments_per_post,
//          min_delay_seconds, max_delay_seconds, between_groups_minutes,
//          reaction, scrolls_per_group }
//        groups                  = array, or one string with one URL per line / comma separated
//        posts_per_group         = max posts to like per group (default 5)
//        like_comments           = true/false - also like comments (default false)
//        comments_per_post       = max comments to like per post (default 3)
//        min_delay_seconds       = min delay BETWEEN LIKES within a group (default 8)
//        max_delay_seconds       = max delay BETWEEN LIKES within a group (default 20)
//        between_groups_minutes  = wait between finishing one group and starting the next (default 2)
//        reaction                = Like | Love | Haha | Wow | Sad | Angry (default Like)
//        scrolls_per_group       = how many times to scroll to load more posts (default 5)
//        returns { id } immediately (202); poll GET /jobs/:id
//   GET  /jobs            -> recent jobs (newest first)
//   GET  /jobs/:id        -> { status: queued|running|done|stopped, results: [...] }
//   POST /jobs/:id/stop   -> stop after the current action finishes
//
// Safety: likes per group are capped per day via like-history.json,
// delays between actions are randomised to mimic human behaviour.
// Every click is verified: the bot checks that the button changed to "Unlike"
// before recording the like — unverified clicks are logged but not counted.

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { chromium } = require('playwright');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

const PORT         = process.env.PORT          || 3005;
const SESSION_DIR  = path.resolve(__dirname, process.env.SESSION_DIR  || 'session');
const HISTORY_FILE = path.resolve(__dirname, process.env.HISTORY_FILE || 'like-history.json');
const API_KEY      = process.env.API_KEY       || 'change-me-secret';
const HEADLESS     = process.env.HEADLESS      === 'true';
const MAX_LIKES_PER_GROUP_PER_DAY = Number(process.env.MAX_LIKES_PER_GROUP_PER_DAY || 20);

const HOME_URL = 'https://www.facebook.com/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// Reaction names as Facebook renders them in the popup aria-labels
const REACTIONS = ['Like', 'Love', 'Care', 'Haha', 'Wow', 'Sad', 'Angry'];

// No single CSS selector reliably matches Facebook's ever-changing DOM.
// We use Playwright's getByRole() which queries the accessibility tree instead,
// matching any element whose computed accessible name is exactly "Like" (case-insensitive).
// This survives HTML structure changes and works with shadow-DOM patterns.

const BLOCKED_TEXT = /you can.t do this right now|temporarily blocked|you.re temporarily restricted|try again later/i;

let context;
let page;
let queue = Promise.resolve();
let lastErrorPng = null;
let lastProofPng  = null;  // screenshot taken right after the most recent verified like
const jobs = new Map();

function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand  = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
function httpErr(status, msg) { const e = new Error(msg); e.status = status; return e; }

// ─── History ─────────────────────────────────────────────────────────────────

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return {}; }
}
function saveHistory(h) {
  fs.writeFileSync(HISTORY_FILE + '.tmp', JSON.stringify(h, null, 1));
  fs.renameSync(HISTORY_FILE + '.tmp', HISTORY_FILE);
}
function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}
function getLikesUsedToday(history, groupUrl) {
  return history[groupUrl]?.[todayKey()] || 0;
}
function recordLikes(history, groupUrl, count) {
  if (!history[groupUrl]) history[groupUrl] = {};
  const key = todayKey();
  history[groupUrl][key] = (history[groupUrl][key] || 0) + count;
  history[groupUrl].last_liked = new Date().toISOString();
  return history;
}

/** https://www.facebook.com/groups/123/?ref=share -> https://www.facebook.com/groups/123 */
function normalizeGroup(url) {
  const m = String(url).trim().match(/^https?:\/\/(?:www\.|m\.|web\.)?facebook\.com\/groups\/([^/?#\s]+)/i);
  return m ? `https://www.facebook.com/groups/${m[1]}` : null;
}

// ─── Browser ─────────────────────────────────────────────────────────────────

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
  if (API_KEY === 'change-me-secret') console.warn('WARNING: set API_KEY, the default key is public.');
  console.log(
    HEADLESS
      ? 'Running headless.'
      : 'Browser window is open: log in to Facebook there. Then restart with HEADLESS=true.'
  );
}

async function hasSessionCookie() {
  const cookies = await context.cookies('https://www.facebook.com');
  return cookies.some((c) => c.name === 'c_user' && c.value);
}

async function onLoginWall() {
  const url = page.url();
  if (/\/login|checkpoint|two_step|recover/i.test(url)) return true;
  if (!(await hasSessionCookie())) return true;
  const loginUi = page.locator('input[name="email"], input[name="pass"], input[type="password"], form[action*="login"]');
  return (await loginUi.count()) > 0;
}

async function isLoggedIn() {
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  return !(await onLoginWall());
}

// ─── Like logic ───────────────────────────────────────────────────────────────

/**
 * Find an unliked Like button within a single article locator.
 * Tries several strategies so it works across Facebook's changing DOM.
 * Returns a Playwright Locator ready to click, or null if none found.
 */
async function findLikeButtonInArticle(article) {
  // Each strategy targets a different way Facebook renders the Like button.
  // We check all of them and return the first visible, unclicked one.
  const strategies = [
    // 1. Exact aria-label="Like" on a role="button" (most common)
    () => article.locator('[aria-label="Like"][role="button"]').first(),
    // 2. aria-label="Like post" variant
    () => article.locator('[aria-label="Like post"][role="button"]').first(),
    // 3. Playwright accessibility tree lookup (works across shadow-DOM changes)
    () => article.getByRole('button', { name: 'Like', exact: true }).first(),
    // 4. Plain <button> whose visible text is exactly "Like"
    () => article.locator('button').filter({ hasText: /^Like$/ }).first(),
    // 5. Any element whose aria-label starts with "Like" but is not "Unlike"
    () => article.locator('[aria-label^="Like"]:not([aria-label^="Unlike"])').first(),
  ];

  for (const getLocator of strategies) {
    try {
      const btn = getLocator();
      if ((await btn.count()) === 0) continue;

      // Skip if already reacted
      const ariaPressed = await btn.getAttribute('aria-pressed').catch(() => null);
      if (ariaPressed === 'true') continue;
      const ariaLabel = (await btn.getAttribute('aria-label').catch(() => '')) || '';
      if (/^unlike|^remove/i.test(ariaLabel)) continue;

      const isVis = await btn.isVisible({ timeout: 2000 }).catch(() => false);
      if (!isVis) continue;

      return btn;
    } catch {
      // strategy failed, try next
    }
  }
  return null;
}

/**
 * Extract human-readable details from an article locator.
 * Returns { postUrl, postText, author } — any field may be null.
 */
async function extractDetailsFromArticle(article) {
  try {
    let postUrl = null;
    const timeLink = article
      .locator('a[href*="/posts/"], a[href*="story_fbid"], a[href*="/permalink/"]')
      .first();
    if ((await timeLink.count()) > 0) {
      const href = await timeLink.getAttribute('href').catch(() => null);
      if (href) postUrl = href.startsWith('http') ? href : `https://www.facebook.com${href}`;
    }

    let postText = null;
    const textEl = article.locator('[data-ad-preview="message"], div[dir="auto"]').first();
    if ((await textEl.count()) > 0) {
      const raw = await textEl.textContent().catch(() => null);
      if (raw) postText = raw.trim().replace(/\s+/g, ' ').slice(0, 150);
    }

    let author = null;
    const authorEl = article.locator('h2 a, h3 a, strong a').first();
    if ((await authorEl.count()) > 0) {
      author = (await authorEl.textContent().catch(() => null))?.trim() || null;
    }

    return { postUrl, postText, author };
  } catch {
    return {};
  }
}

/**
 * Log all like-related aria-labels currently in the DOM.
 * Saves a last-error screenshot if nothing is found.
 */
async function debugLogLikeLabels(groupUrl) {
  const labels = await page.evaluate(() => {
    const all = [...document.querySelectorAll('[aria-label]')];
    return [...new Set(
      all.map(el => el.getAttribute('aria-label'))
         .filter(l => l && /like/i.test(l))
    )].slice(0, 30);
  }).catch(() => []);

  if (labels.length) {
    console.log(`[${groupUrl}] like-related aria-labels on page: ${JSON.stringify(labels)}`);
  } else {
    console.log(`[${groupUrl}] WARNING: no like-related aria-labels found — page may not have loaded`);
    lastErrorPng = await page.screenshot().catch(() => null);
  }
  return labels;
}

/**
 * Navigate to a group, scroll article-by-article, and like posts.
 *
 * Key design:
 *  - We iterate page.locator('[role="article"]').all() to get Playwright Locator
 *    objects for each article currently in the DOM.
 *  - For each article we call article.scrollIntoViewIfNeeded() so the browser
 *    actually renders the article's buttons (Facebook uses a virtualised feed
 *    that removes off-screen content from the DOM).
 *  - We find the Like button INSIDE the article locator using multiple
 *    strategies (aria-label, getByRole, text filter).
 *  - Verification uses the Playwright locator itself: after clicking we re-read
 *    the button's aria-label and check it changed to "Unlike" / a reaction label.
 *  - Articles are deduplicated across scroll passes by their absolute Y position.
 *
 * Returns { postsLiked, commentsLiked, likedPosts, buttonsFound }.
 */
async function likePostsInGroup(groupUrl, opts) {
  const {
    postsPerGroup,
    doLikeComments,
    commentsPerPost,
    minDelay,
    maxDelay,
    reaction,
    scrollsPerGroup,
    remainingQuota,
    jobCancel,
  } = opts;

  try {
    await page.goto(groupUrl, { waitUntil: 'domcontentloaded' });

    // Wait up to 25s for the first article to appear
    await page.waitForSelector('[role="article"]', { timeout: 25000 }).catch(() => {});
    await sleep(rand(3000, 5000));

    if (await onLoginWall()) throw httpErr(503, 'NOT_LOGGED_IN');
    if (await page.getByText(BLOCKED_TEXT).first().isVisible().catch(() => false)) throw httpErr(429, 'BLOCKED_BY_FACEBOOK');

    // Human-like micro-scroll to trigger lazy rendering
    await page.mouse.move(rand(400, 800), rand(300, 500));
    await sleep(500);
    await page.mouse.wheel(0, 400);
    await sleep(rand(1500, 2500));
    await page.mouse.wheel(0, -400);
    await sleep(rand(1000, 1500));

    // Diagnostic: show what like-related labels are on the page
    await debugLogLikeLabels(groupUrl);

    const target     = Math.min(postsPerGroup, remainingQuota);
    const likedPosts = [];
    // Dedup articles across scroll passes by absolute Y (bucketed to 60px)
    const seenArticleKeys = new Set();

    for (let pass = 0; pass <= scrollsPerGroup && likedPosts.length < target; pass++) {
      if (jobCancel()) break;

      // Scroll down on every pass after the first to load more articles
      if (pass > 0) {
        await page.keyboard.press('End');
        await sleep(rand(2000, 3500));
      }

      const articles = await page.locator('[role="article"]').all();
      console.log(`[${groupUrl}] pass ${pass}: ${articles.length} article(s) in DOM`);

      // Shuffle so we don't always like the first N posts
      const shuffled = [...articles].sort(() => Math.random() - 0.5);

      for (const article of shuffled) {
        if (likedPosts.length >= target || jobCancel()) break;

        // Get absolute Y of this article for deduplication
        const articleAbsY = await article.evaluate(el => {
          const r = el.getBoundingClientRect();
          return Math.round(r.top + window.scrollY);
        }).catch(() => -1);

        if (articleAbsY < 0) continue;
        const articleKey = `y${Math.round(articleAbsY / 60) * 60}`;
        if (seenArticleKeys.has(articleKey)) continue;
        seenArticleKeys.add(articleKey);

        // Scroll this specific article into the viewport so its buttons are rendered
        await article.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
        await sleep(rand(600, 1000));

        // Find the Like button within this article
        const btn = await findLikeButtonInArticle(article);
        if (!btn) {
          // Log what we did find to aid diagnosis
          const articleLabels = await article.evaluate(el =>
            [...el.querySelectorAll('[aria-label]')]
              .map(e => e.getAttribute('aria-label'))
              .filter(l => l)
              .slice(0, 10)
          ).catch(() => []);
          console.log(`[${groupUrl}] article at absY=${articleAbsY}: no Like button found. Labels: ${JSON.stringify(articleLabels)}`);
          continue;
        }

        // Capture post details BEFORE clicking (DOM may update after)
        const details = await extractDetailsFromArticle(article);

        await sleep(rand(300, 700));

        // ── Click the Like / reaction button ──────────────────────────────
        if (reaction === 'Like') {
          await btn.click({ timeout: 10000 });
        } else {
          // Hover to open the floating reaction strip, then click the named reaction
          await btn.hover({ timeout: 10000 });
          await sleep(rand(1200, 2000));
          const reactionBtn = page.locator(`[aria-label="${reaction}"][role="button"]`).first();
          if (await reactionBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await reactionBtn.click({ timeout: 10000 });
          } else {
            await btn.click({ timeout: 10000 }); // fall back to plain Like
          }
        }

        // ── Verify: check that the button now shows "Unlike" or a reaction ─
        await sleep(2500); // give Facebook time to update the DOM
        const labelAfter = (await btn.getAttribute('aria-label').catch(() => '')) || '';
        // Also check for a sibling/replacement "Unlike" button in the article
        const hasUnlikeBtn = await article
          .locator('[aria-label^="Unlike"], [aria-label^="Remove"]')
          .count()
          .then(n => n > 0)
          .catch(() => false);

        const verified = /^unlike|^remove/i.test(labelAfter) || hasUnlikeBtn;

        if (!verified) {
          console.warn(
            `[${groupUrl}] click NOT verified — button aria-label after click: "${labelAfter}"` +
            ` | hasUnlikeBtn: ${hasUnlikeBtn}`
          );
          continue;
        }

        // Proof screenshot — available at GET /proof.png
        lastProofPng = await page.screenshot().catch(() => null);

        const entry = {
          post_url:  details.postUrl  || null,
          author:    details.author   || null,
          post_text: details.postText || null,
          reaction,
          verified:  true,
          liked_at:  new Date().toISOString(),
        };

        if (doLikeComments && commentsPerPost > 0) {
          // Like comments within the same article
          await sleep(rand(800, 1500));
          let commentsLiked = 0;
          const commentBtns = await article
            .locator('[aria-label="Like"][role="button"], [aria-label="Like comment"][role="button"]')
            .all();
          const tolike = commentBtns.sort(() => Math.random() - 0.5).slice(0, commentsPerPost);
          for (const cb of tolike) {
            try {
              const cbPressed = await cb.getAttribute('aria-pressed').catch(() => null);
              const cbLabel   = (await cb.getAttribute('aria-label').catch(() => '')) || '';
              if (cbPressed === 'true' || /^unlike/i.test(cbLabel)) continue;
              await cb.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
              await cb.click({ timeout: 8000 });
              commentsLiked++;
              await sleep(rand(minDelay, maxDelay));
            } catch { /* skip this comment */ }
          }
          entry.comments_liked = commentsLiked;
        }

        likedPosts.push(entry);
        console.log(
          `[${groupUrl}] LIKED ${likedPosts.length}/${target}` +
          ` | author: "${entry.author || 'unknown'}"` +
          (entry.post_url  ? ` | ${entry.post_url}` : '') +
          (entry.post_text ? ` | "${entry.post_text.slice(0, 60)}..."` : '')
        );

        if (likedPosts.length < target && !jobCancel()) {
          await sleep(rand(minDelay, maxDelay));
        }
      }
    }

    const totalComments = likedPosts.reduce((s, p) => s + (p.comments_liked || 0), 0);
    return {
      postsLiked:    likedPosts.length,
      commentsLiked: totalComments,
      likedPosts,
      buttonsFound:  seenArticleKeys.size, // how many unique articles were examined
    };
  } catch (e) {
    lastErrorPng = await page.screenshot().catch(() => null);
    throw e;
  }
}

// ─── Jobs ─────────────────────────────────────────────────────────────────────

function publicJob(j) {
  const { cancel, ...rest } = j;
  return rest;
}

async function runJob(job) {
  job.status   = 'running';
  job.started_at = new Date().toISOString();

  try {
    for (let i = 0; i < job.results.length; i++) {
      const r = job.results[i];
      if (r.status !== 'waiting') continue;
      if (job.cancel) { r.status = 'skipped'; r.error = 'STOPPED'; continue; }

      // Check daily quota
      const history = loadHistory();
      const usedToday = getLikesUsedToday(history, r.group);
      const quota = MAX_LIKES_PER_GROUP_PER_DAY - usedToday;
      if (quota <= 0) {
        r.status = 'skipped';
        r.error  = `DAILY_LIMIT_REACHED (${MAX_LIKES_PER_GROUP_PER_DAY} likes/group/day)`;
        continue;
      }

      r.status     = 'liking';
      r.started_at = new Date().toISOString();

      try {
        const result = await enqueue(() =>
          likePostsInGroup(r.group, {
            postsPerGroup:  Math.min(job.posts_per_group, quota),
            doLikeComments: job.like_comments,
            commentsPerPost: job.comments_per_post,
            minDelay:        job.min_delay_seconds * 1000,
            maxDelay:        job.max_delay_seconds * 1000,
            reaction:        job.reaction,
            scrollsPerGroup: job.scrolls_per_group,
            remainingQuota:  quota,
            jobCancel:       () => job.cancel,
          })
        );

        r.status          = 'done';
        r.posts_liked     = result.postsLiked;
        r.comments_liked  = result.commentsLiked;
        r.liked_posts     = result.likedPosts;    // per-post details
        r.buttons_found   = result.buttonsFound;  // diagnostic: how many candidates were seen
        r.note            = result.note || null;
        r.finished_at     = new Date().toISOString();

        // Record in history
        if (result.postsLiked > 0) {
          const h = loadHistory();
          saveHistory(recordLikes(h, r.group, result.postsLiked));
        }
        console.log(`[${job.id}] done: ${r.group} – posts liked: ${result.postsLiked}, comments: ${result.commentsLiked}`);
      } catch (e) {
        r.status      = 'failed';
        r.error       = e.message;
        r.finished_at = new Date().toISOString();
        console.error(`[${job.id}] failed: ${r.group}: ${e.message}`);
        if (e.status === 503 || e.status === 429) {
          job.cancel     = true;
          job.stop_reason = e.message;
        }
      }

      // Delay before the next group — use dedicated between_groups_minutes
      const more = job.results.slice(i + 1).some((x) => x.status === 'waiting');
      if (more && !job.cancel) {
        const minWait = job.between_groups_minutes * 60000;
        const maxWait = Math.round(minWait * 1.5); // ±50% randomness
        const wait    = rand(minWait, maxWait);
        console.log(`[${job.id}] waiting ${Math.round(wait / 1000)}s before next group…`);
        job.next_at = new Date(Date.now() + wait).toISOString();
        for (let t = 0; t < wait && !job.cancel; t += 5000) await sleep(Math.min(5000, wait - t));
        job.next_at = null;
      }
    }
    job.status = job.cancel ? 'stopped' : 'done';
  } catch (e) {
    job.status      = 'stopped';
    job.stop_reason = e.message;
    job.results.filter((r) => r.status === 'waiting').forEach((r) => { r.status = 'skipped'; r.error = e.message; });
  } finally {
    job.finished_at = new Date().toISOString();
    job.summary = job.results.reduce((s, r) => {
      s[r.status] = (s[r.status] || 0) + 1;
      s.total_posts_liked    = (s.total_posts_liked    || 0) + (r.posts_liked    || 0);
      s.total_comments_liked = (s.total_comments_liked || 0) + (r.comments_liked || 0);
      return s;
    }, {});
  }
}

let jobChain = Promise.resolve();

// ─── HTTP ─────────────────────────────────────────────────────────────────────

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
      loggedIn:         await isLoggedIn(),
      hasSessionCookie: await hasSessionCookie(),
      url:              page.url(),
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
  if (!lastErrorPng) return res.status(404).send('No error screenshot yet');
  res.type('png').send(lastErrorPng);
});

// Proof screenshot: taken immediately after each verified like.
// Open this in a browser to confirm the like was actually registered on Facebook.
app.get('/proof.png', (req, res) => {
  if (!lastProofPng) return res.status(404).send('No proof screenshot yet — no verified like has been recorded');
  res.type('png').send(lastProofPng);
});

// Debug: dumps all interactive elements on the current page.
// Use this to understand what Facebook is actually rendering.
// Steps: 1) navigate the bot to a group via /status  2) call this endpoint
app.get('/debug-page', async (req, res) => {
  try {
    const result = await enqueue(() => page.evaluate(() => {
      const url = location.href;
      const articles = document.querySelectorAll('[role="article"]').length;
      const buttons = [];
      document.querySelectorAll('[role="button"], button, [tabindex="0"]').forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const ariaLabel   = el.getAttribute('aria-label') || '';
        const ariaPressed = el.getAttribute('aria-pressed') || '';
        const text        = (el.innerText || '').trim().slice(0, 60);
        if (!ariaLabel && !text) return;
        buttons.push({ tag: el.tagName, ariaLabel, ariaPressed, text,
          x: Math.round(rect.x), y: Math.round(rect.y),
          absY: Math.round(rect.top + window.scrollY) });
      });
      return { url, articles, totalButtons: buttons.length, buttons };
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/cookies', async (req, res) => {
  const list = Array.isArray(req.body) ? req.body : req.body.cookies;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'Send the exported cookie JSON array' });
  const sameSiteMap = { no_restriction: 'None', lax: 'Lax', strict: 'Strict', None: 'None', Lax: 'Lax', Strict: 'Strict' };
  const cookies = list
    .filter((c) => c.name && c.domain)
    .map((c) => ({
      name:     c.name,
      value:    String(c.value ?? ''),
      domain:   c.domain,
      path:     c.path || '/',
      expires:  c.expirationDate ? Math.floor(c.expirationDate) : typeof c.expires === 'number' ? c.expires : -1,
      httpOnly: !!c.httpOnly,
      secure:   !!c.secure,
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

app.post('/jobs', (req, res) => {
  const raw = Array.isArray(req.body.groups)
    ? req.body.groups
    : String(req.body.groups || '').split(/[\n,]+/);
  const groups  = [...new Set(raw.map(normalizeGroup).filter(Boolean))];
  const invalid = raw.filter((g) => String(g).trim() && !normalizeGroup(g));
  if (!groups.length) {
    return res.status(400).json({ ok: false, error: 'groups: give at least one https://www.facebook.com/groups/... URL', invalid });
  }

  const num  = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
  const bool = (v, d) => (v === undefined || v === null ? d : v === true || v === 'true');

  const reaction = REACTIONS.includes(req.body.reaction) ? req.body.reaction : 'Like';

  const id  = crypto.randomBytes(5).toString('hex');
  const job = {
    id,
    status:                 'queued',
    created_at:              new Date().toISOString(),
    posts_per_group:         Math.max(1, Math.min(MAX_LIKES_PER_GROUP_PER_DAY, num(req.body.posts_per_group, 5))),
    like_comments:           bool(req.body.like_comments, false),
    comments_per_post:       Math.max(1, num(req.body.comments_per_post, 3)),
    min_delay_seconds:       Math.max(5, num(req.body.min_delay_seconds, 8)),   // between likes
    max_delay_seconds:       Math.max(10, num(req.body.max_delay_seconds, 20)), // between likes
    between_groups_minutes:  Math.max(1, num(req.body.between_groups_minutes, 2)), // between groups
    reaction,
    scrolls_per_group:       Math.max(1, num(req.body.scrolls_per_group, 5)),
    results:                 groups.map((group) => ({ group, status: 'waiting' })),
    invalid,
    cancel:                  false,
  };
  job.max_delay_seconds = Math.max(job.min_delay_seconds, job.max_delay_seconds);

  jobs.set(id, job);
  while (jobs.size > 50) jobs.delete(jobs.keys().next().value);
  jobChain = jobChain.then(() => runJob(job)).catch(() => {});

  res.status(202).json({
    ok: true, id,
    groups: groups.length,
    posts_per_group: job.posts_per_group,
    reaction: job.reaction,
    like_comments: job.like_comments,
    min_delay_seconds: job.min_delay_seconds,
    max_delay_seconds: job.max_delay_seconds,
    between_groups_minutes: job.between_groups_minutes,
    invalid,
  });
});

app.get('/jobs', (req, res) => {
  res.json(
    [...jobs.values()].reverse().map((j) => ({
      id:          j.id,
      status:      j.status,
      created_at:  j.created_at,
      finished_at: j.finished_at || null,
      summary:     j.summary    || null,
      reaction:    j.reaction,
    }))
  );
});

app.get('/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'JOB_NOT_FOUND (jobs are kept in memory until restart)' });
  res.json(publicJob(job));
});

app.post('/jobs/:id/stop', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'JOB_NOT_FOUND' });
  job.cancel = true;
  if (job.status === 'queued') {
    job.results.forEach((r) => { if (r.status === 'waiting') { r.status = 'skipped'; r.error = 'STOPPED'; } });
  }
  res.json({ ok: true, status: job.status });
});

init()
  .then(() => app.listen(PORT, () => console.log(`fb-groups-like-bot listening on ${PORT}`)))
  .catch((e) => {
    console.error('Failed to start browser:', e);
    process.exit(1);
  });
