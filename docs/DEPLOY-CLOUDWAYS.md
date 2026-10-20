# Deploying to Cloudways

Live URL: **https://auction.harcourts3kings.co.nz**

```
push to main ──► GitHub Actions: tests → build (frontend + /api) ──► branch `cloudways`
                                                                        │
                    Cloudways "Deployment via Git" — Pull ──────────────┴──► public_html
                                                                              ├─ index.html, index.php, assets/  (the app)
                                                                              └─ api/                           (PHP API)
<app>/private_html/auction-live-config.php  ← database password, NOT in Git
MySQL database (Cloudways)                  ← all sessions, bids, audit trail, staff accounts, photos
```

## One-time setup

### 1. Domain + SSL
Application → **Domain Management** → `auction.harcourts3kings.co.nz` → Make Primary.
Application → **SSL Certificate** → Let's Encrypt → Install, Auto Renewal on.

### 2. Database settings file
1. Cloudways → Application → **Access Details → MySQL Access**: note *DB Name*, *Username*, *Password*.
2. Copy `backend/api/config.example.php`, fill in those three values and a long random `setup_key`.
3. SFTP: upload it as **`private_html/auction-live-config.php`** (the folder *next to* `public_html`, so it is never web-accessible).
   Alternative if `private_html` is not available: `public_html/api/config.local.php`.

Tables are created automatically on the first request.

### 3. Git deployment
1. GitHub → Actions → **Build for Cloudways** must be green (creates the `cloudways` branch).
2. Cloudways → **Deployment via Git** → Generate SSH key → add it in GitHub → Settings → **Deploy keys**.
3. Remote `git@github.com:alexisgit111/auctionlive.git`, branch **`cloudways`**, path `public_html` → Start Deployment.

Manual alternative: download the `cloudways` branch as ZIP from GitHub and upload its contents to `public_html` by SFTP.

### 4. First admin
Open the site → you are sent to **First-time setup** → enter the `setup_key`, your name, email and password.
The setup page disables itself once an admin exists. Then add staff under **Users**.

## Every update
Push to `main` → wait for the green tick → Cloudways **Pull**.
A failing test stops the build, so a broken version never reaches the server.

Do **not** delete from `public_html`: `index.php` (serves the app on Nginx) and `api/`.

## Checks
- `https://auction.harcourts3kings.co.nz/api/index.php?r=/health` → `{"ok":true,...}`
- `/auction/control` → sign-in page; after sign-in the console.
- Same sessions visible from a second computer.
- `https://auction.harcourts3kings.co.nz/api/lib/core.php` → empty page or 404 (never code).

## Room display computer
1. Connect the PC to the room TV (16:9), set Windows/macOS to never sleep and turn off screen savers.
2. Open Chrome at `https://auction.harcourts3kings.co.nz/auction/pair` — a 6-character code appears.
3. On the console (signed in, session open) → **Room display** panel → type the code → **Approve**. The screen switches to the display by itself.
4. Fullscreen: double-click the screen or press F11. For a dedicated PC use kiosk mode:
   `chrome.exe --kiosk https://auction.harcourts3kings.co.nz/auction/pair` (Windows shortcut / startup folder).
5. The pairing is remembered in that browser. Reopening `/auction/pair` goes straight back to the display while the
   session is running; after a session has ended (or the device was revoked) it shows a new code for the next session.
6. **Next property, same screen:** open the next session in the console → Room display → *Screens on other sessions* →
   **Show this session**. The screen switches within a second; no new code needed.

Updates reach the screen almost instantly: the server holds each display request open (≤ 3.5 s) and answers the moment
the auction changes. Each room display keeps one PHP worker busy while it waits; set `'display_wait_ms' => 0` in the
config file to fall back to plain 1-second polling.

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| "Server is not configured yet" | Config file missing or in the wrong folder (step 2) |
| "Cannot connect to the database" | Wrong DB name / user / password in the config file |
| 404 on `/auction/...` | `public_html/index.php` missing — Pull again |
| Room display shows CONNECTION LOST | Display PC offline, or the session ended and the display was revoked — re-pair |
