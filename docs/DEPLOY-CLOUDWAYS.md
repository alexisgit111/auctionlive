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

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| "Server is not configured yet" | Config file missing or in the wrong folder (step 2) |
| "Cannot connect to the database" | Wrong DB name / user / password in the config file |
| 404 on `/auction/...` | `public_html/index.php` missing — Pull again |
| Room display shows CONNECTION LOST | Display PC offline, or the session ended and the display was revoked — re-pair |
