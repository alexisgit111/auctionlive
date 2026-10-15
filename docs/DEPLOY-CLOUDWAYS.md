# Deploying to Cloudways (Phase 1A prototype)

Test URL: **https://auction.harcourts3kings.co.nz**

The prototype is a static site: GitHub Actions builds it and Cloudways only serves files.
No Node.js, database or Supervisor is needed on the server for Phase 1A.

```
push to main ──► GitHub Actions: npm ci → tests → build ──► branch `cloudways` (built files)
                                                                   │
                         Cloudways "Deployment via Git" ── pull ───┘──► public_html
```

## 1. Map the domain (fixes "403 Website Unavailable")

Cloudways → **Applications** → your Auction Live app → **Domain Management**
→ add `auction.harcourts3kings.co.nz` → **Make Primary**.

DNS: an `A` record for `auction` pointing to the server's public IP (shown on the server page).

## 2. SSL

Same app → **SSL Certificate** → **Let's Encrypt** → email + `auction.harcourts3kings.co.nz` → Install.
Turn on **Auto Renewal**. (Do this after DNS resolves, or Let's Encrypt fails.)

## 3. Connect Git (one time)

1. Push `main` once with `.github/workflows/deploy-cloudways.yml` in it.
   GitHub → **Actions** tab → wait for **Build for Cloudways** to go green.
   This creates the `cloudways` branch.
2. Cloudways → app → **Deployment via Git** → **Generate SSH keys** → **View SSH key** → copy.
3. GitHub → repo → **Settings → Deploy keys → Add deploy key** → paste, read-only is enough.
4. Back in Cloudways:
   - Git remote address: `git@github.com:alexisgit111/auctionlive.git`
   - **Authenticate** → Branch: **`cloudways`**
   - Deployment path: `public_html` (leave the box empty = public_html)
   - **Start Deployment**

## 4. Every later update

1. Push to `main`.
2. Wait for the green tick in GitHub Actions (about 1 minute).
3. Cloudways → **Deployment via Git** → **Pull**.

If a test fails, the build stops and nothing is published, so a broken version never reaches the server.

## 5. Protect it (recommended — internal tool)

Cloudways → app → **Application Settings → Password Protection** → enable, set a username and password.

Note: the room display page will also ask for this password once per browser.

## 6. Check it

- `https://auction.harcourts3kings.co.nz/auction/control` loads the console.
- Refreshing any `/auction/...` page does **not** show 404 (handled by `.htaccess`).
- `http://` redirects to `https://`.

## Limits of the Phase 1A prototype online

Data lives in each browser's local storage. The console and room display must be windows of the
**same browser on the same computer** (e.g. laptop + TV as an extended screen).
Two separate computers will sync only after Phase 1B/1C (Laravel API + WebSockets) is deployed.
