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
6. **Next property, same screen** — any of these, no re-pairing needed:
   - Console: open the next session → the blue banner "*Auction room screen* is showing …" → **Show this session**.
   - Console: on the session the screen is on → Room display → **Move to…** → pick the next session.
   - Screen computer: move the mouse → **⇄ Change session** (bottom-left) → a new code appears → enter it on the
     console of the session you want. The old pairing is retired automatically.
7. Opening `/auction/pair` on a screen that is already paired shows which property it is on, with
   **Show a different session**; untouched, it returns to the display after 8 s (kiosk reboot).

Updates reach the screen almost instantly: the server holds each display request open (≤ 3.5 s) and answers the moment
the auction changes. Each room display keeps one PHP worker busy while it waits; set `'display_wait_ms' => 0` in the
config file to fall back to plain 1-second polling.

## Room media (welcome screen + music)
- **Media** page (admins): the welcome image (built-in Golden Links image by default) and the music — the same for every
  session. Music uploads go in 512 KB pieces, so the host's upload limit doesn't matter; files are stored in
  `<app>/private_html/auction-media/` (outside the web root, untouched by Git deploys — include it in backups).
  Override the folder with `'media_dir' => '/path'` in the config file if needed.
- Console / phone: **Welcome** and **Music** buttons, volume slider. *Start auction* closes the welcome screen;
  *Pause* starts the music, *Resume* / Sold / Passed in stop it.
- Sound plays only on the room screen computer. Allow sound for the site once in Chrome on that computer
  (address-bar icon → Site settings → Sound: Allow) or add `--autoplay-policy=no-user-gesture-required` to the kiosk
  shortcut. If Chrome still blocks it, the console shows "Sound blocked" and the screen shows "Click to turn on sound".
- Public performance of commercial music needs a OneMusic NZ licence.

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| "Server is not configured yet" | Config file missing or in the wrong folder (step 2) |
| "Cannot connect to the database" | Wrong DB name / user / password in the config file |
| 404 on `/auction/...` | `public_html/index.php` missing — Pull again |
| "Sound blocked on the room screen" | Click the screen once, or allow Sound for the site in Chrome (see Room media) |
| Music upload fails | PHP must be able to create `private_html/auction-media` — check folder permissions |
| Room display shows CONNECTION LOST | Display PC offline, or the session ended and the display was revoked — re-pair |
