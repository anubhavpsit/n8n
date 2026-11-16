# Facebook Groups Like Automation

Automatically likes (or reacts to) posts and comments in a list of Facebook groups.
Built on Playwright + Express, controlled by an n8n workflow via a local HTTP API.

---

## How it works

1. The n8n workflow triggers on a schedule (default: every day at 11 AM).
2. It calls the bot's `/status` endpoint to confirm Facebook is logged in.
3. If logged in, it starts a **like job** via `POST /jobs` with your list of group URLs.
4. The bot navigates to each group, scrolls to load posts, randomly selects posts to like, and optionally likes comments too.
5. n8n polls `GET /jobs/:id` every 30 seconds until the job finishes.
6. If not logged in, an email alert is sent instead.

---

## Project structure

```
fb-groups-like-automation/
├── n8n-fb-groups-like.json        ← n8n workflow — import this into n8n
├── .gitignore
└── fb-groups-like-bot/
    ├── server.js                  ← bot server (Playwright + Express)
    ├── package.json
    ├── .env.sample                ← copy to .env and fill in values
    ├── session/                   ← browser session (auto-created, git-ignored)
    └── like-history.json          ← daily like counts per group (auto-created, git-ignored)
```

---

## Setup

### 1. Install dependencies

```bash
cd fb-groups-like-bot
npm install
npx playwright install chromium
```

### 2. Configure environment

```bash
cp .env.sample .env
```

Edit `.env`:

```env
API_KEY=your-long-random-secret      # must match the key set in the n8n workflow
PORT=3005
HEADLESS=false                       # keep false for first login
MAX_LIKES_PER_GROUP_PER_DAY=20
SESSION_DIR=./session
HISTORY_FILE=./like-history.json
```

Generate a strong API key:
```bash
openssl rand -hex 16
```

### 3. Log in to Facebook (first time only)

Start the bot with the browser visible:

```bash
node server.js
```

A browser window will open. Log in to Facebook normally, then press `Ctrl+C`.

### 4. Run as a background service (pm2)

```bash
# Install pm2 globally if you haven't already
npm install -g pm2

# Start the bot headless
HEADLESS=true pm2 start server.js --name fb-groups-like-bot
pm2 save
pm2 startup   # so it auto-starts on reboot
```

Useful pm2 commands:
```bash
pm2 status                      # check if the bot is running
pm2 logs fb-groups-like-bot     # view live logs
pm2 restart fb-groups-like-bot  # restart after editing .env
pm2 stop fb-groups-like-bot     # stop the bot
```

---

## Importing the n8n workflow

1. Open n8n → **Workflows** → click **+** → **Import from file**
2. Select `n8n-fb-groups-like.json`
3. Update the placeholders listed below, then **Save** and **Activate**

### Placeholders to update

| Node | Field | What to set |
|---|---|---|
| All HTTP Request nodes | `x-api-key` header value | Your `API_KEY` from `.env` |
| **Start Like Job** | `groups` array in JSON body | Your actual Facebook group URLs |
| **Start Like Job** | `posts_per_group` | Posts to like per group per run (default `5`) |
| **Start Like Job** | `reaction` | `Like`, `Love`, `Haha`, `Wow`, `Sad`, or `Angry` |
| **Start Like Job** | `like_comments` | `true` to also like comments under posts |
| **Start Like Job** | `scrolls_per_group` | How many times to scroll to load more posts (default `5`) |
| **Every Day 11 AM** | `triggerAtHour` | Hour to run (0–23, IST) |
| **Email Login Alert** | `fromEmail` / `toEmail` | Your email address |

---

## API reference

All endpoints require either an `x-api-key` header or a `?key=` query parameter.

### GET /status
Returns login state.
```json
{ "loggedIn": true, "hasSessionCookie": true, "url": "https://www.facebook.com/" }
```

### GET /screen.png
Returns a live screenshot of what the browser currently sees. Useful for debugging.

### GET /last-error.png
Returns a screenshot captured at the moment of the last failure.

### POST /cookies
Import cookies exported from your browser (e.g. with the Cookie-Editor extension).
Send the raw cookie JSON array as the request body.

### POST /jobs
Start a new like job.

**Request body:**
```json
{
  "groups": [
    "https://www.facebook.com/groups/GROUP_ID_1",
    "https://www.facebook.com/groups/GROUP_ID_2"
  ],
  "posts_per_group": 5,
  "like_comments": false,
  "comments_per_post": 3,
  "min_delay_seconds": 5,
  "max_delay_seconds": 15,
  "reaction": "Like",
  "scrolls_per_group": 5
}
```

**Response (202):**
```json
{ "ok": true, "id": "a1b2c3d4e5", "groups": 2, "reaction": "Like", "like_comments": false }
```

### GET /jobs
List recent jobs (newest first, up to 50 kept in memory).

### GET /jobs/:id
Get full status of a job.

```json
{
  "id": "a1b2c3d4e5",
  "status": "done",
  "reaction": "Like",
  "summary": {
    "done": 2,
    "failed": 0,
    "total_posts_liked": 10,
    "total_comments_liked": 0
  },
  "results": [
    {
      "group": "https://www.facebook.com/groups/GROUP_ID_1",
      "status": "done",
      "posts_liked": 5,
      "comments_liked": 0
    }
  ]
}
```

Job status values: `queued` → `running` → `done` / `stopped`

### POST /jobs/:id/stop
Stop the running job after the current action completes.

---

## Safety features

| Feature | Detail |
|---|---|
| **Daily quota** | `MAX_LIKES_PER_GROUP_PER_DAY` (default 20) — tracked in `like-history.json` per group per calendar day. Excess groups are skipped automatically. |
| **Already-reacted check** | The bot reads `aria-label` before clicking; posts already liked/reacted are skipped automatically. |
| **Random selection** | Posts are shuffled before the bot picks which ones to like, so it never always likes the first N posts. |
| **Random delays** | Every like waits a random amount of time between `min_delay_seconds` and `max_delay_seconds`. |
| **Auto-stop on block** | If Facebook returns a block/restriction message or the session expires, the job stops immediately to avoid further risk. |

---

## Re-logging in after session expiry

**Option A — visible browser:**
```bash
pm2 stop fb-groups-like-bot
HEADLESS=false node server.js   # log in, then Ctrl+C
pm2 start fb-groups-like-bot
```

**Option B — cookie import (no restart):**
1. Install the [Cookie-Editor](https://cookie-editor.com/) browser extension.
2. Go to `facebook.com` in your normal browser and export cookies as JSON.
3. POST the JSON to the bot:
```bash
curl -X POST http://localhost:3005/cookies \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d @cookies.json
```
4. Confirm: `curl "http://localhost:3005/status?key=YOUR_API_KEY"`

---

## Ports used

| Bot | Port |
|---|---|
| fb-bot (profile posts) | 3001 |
| fb-groups-bot (group posts) | 3003 |
| **fb-groups-like-bot (this)** | **3005** |
