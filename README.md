# Golden Links Auction Live

In-room auction control, room display and electronic scribing for Harcourts Golden Links.
**Not** an online bidding platform.

```
AUCTION LIVE/
├─ docs/        PRD, architecture, database, API, real-time, failure recovery, acceptance criteria
├─ frontend/    React + TypeScript + Vite + Tailwind
└─ backend/     PHP 8.1+ API (plain PHP + PDO, MySQL on Cloudways / SQLite for tests)
```

## Two modes

| | Prototype (`npm run dev`) | Server (`VITE_BACKEND=http`, what Cloudways runs) |
|---|---|---|
| Data | this browser only | MySQL — shared by every computer |
| Sign-in | demo accounts, password `demo1234` | real staff accounts (Users page) |
| Room display sync | same browser windows | any computer, checks the server every second |

Deployment: see `docs/DEPLOY-CLOUDWAYS.md`.

## Phase 1A — run the prototype

Requires Node 20+.

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
```

1. Open **http://localhost:5173/auction/control** → *Take control* → *Start auction*.
2. In the Room display panel click **Open display window** (or open `/auction/pair` in another window/screen).
3. Type the 6-character code shown on the display into the console and click **Approve**.
4. Enter bids: `950K` ↵ ↵, `1.1M` ↵ ↵, `F3` ↵ (current + $10K)… The display updates only after confirmation.
5. Use **Test tools · fault injection** to simulate a lost network, dropped/duplicated/reordered events, a failed broadcast or a lost response.
6. Open a second console window, switch the user to *Operator 2*, and see the operator lock.
7. **Reports** shows the append-only bid record and immutable audit trail; export CSV/JSON.

> Phase 1A uses an in-browser mock of the authoritative backend (`src/engine/mockServer.ts`), stored in the browser's
> local storage and synchronised between windows with BroadcastChannel. The console and display must therefore be windows
> of the **same browser on the same computer** for now. Server mode (`VITE_BACKEND=http`, the PHP API) runs them on separate computers. Nothing connects to any Golden Links system.

### Tests

```bash
npm test             # 86 unit tests: K/M parsing, state machine, idempotency, lease, audit, display whitelist, sync
npm run e2e          # Playwright: console + display windows, pairing, bids, faults, undo, sold, operator lock
```

### Keyboard (Staff Console)

| Key | Action |
|---|---|
| digits `.` `K` `M` | type amount (typing anywhere goes to the amount field) |
| `Enter` | preview → confirm → commit |
| `Esc` | back / clear |
| `F1`–`F6` | current + 1K / 5K / 10K / 25K / 50K / 100K |
| `Num +` | current + default increment |
| `Ctrl+Z` | undo last bid (asks for reason) |
| `P` | pause / resume (when amount is empty) |

Double-click the room display to go fullscreen.

## Phone console

On a phone (screen narrower than 768 px) `/auction/control` turns into a calculator-style console:

Works like a calculator — one tap, no confirmations (desktop: the same with Enter):

| Type | Press | Result |
|---|---|---|
| `1K` | **+** | current bid + $1,000 (no bid yet → starts from $0) |
| (nothing) | **+** | current bid + the session's default increment |
| `1.25M` | **SET** | sets $1,250,000 |
| a lower amount, e.g. `1.1M` | **SET** | sets the last bid to it (recorded as a correction, reason "Set on console") |
| `0` | **SET** | hides the price on the room screen until the next bid (SET the same amount shows it again) |
| | **↶ Undo bid** | undoes the last bid at once |

Buttons above the keypad: **On the market · 1st Call · 2nd Call · Sold** and **Pause · Withdrawn & Sold · Pass in ·
Remove** (clears the room-screen stickers). 1st / 2nd Call need a second tap to confirm; the call sticker clears itself on
the next bid. Keypad top row **00 · K · M · C**; **↶ Undo bid** sits between 0 and the decimal point. Touch tablets
(iPad / Android) use this layout too.

**C** clears the typing. Only the money format is checked (whole dollars, max $100M). Before the auction
starts the room screen shows no price. Sold, Passed in, End and Undo SOLD are one tap; reasons are recorded
automatically in the audit trail. Any staff account can take over control in one tap.
Status buttons (Start / Pause / On market / Sold / Passed in) sit above the keypad;
Undo, Correct, stickers, pairing a room screen and End are in the ☰ menu. After Sold / Passed in, **Undo SOLD — reopen…**
puts the auction back exactly where it was (reason recorded; all bids kept). "Phone layout" / "Switch to desktop
layout" force either layout on any device. Add the page to the home screen to run it full screen.

## Room media

Welcome screen (full-screen image + music) and pause music on the room screen, the same for every session.
Admins set the image and music on **Media**; the console and phone have **Welcome** / **Music** buttons and a volume
slider. Start auction closes the welcome screen; Pause starts the music. The screen reports whether sound is playing or
blocked by the browser. Music files are not kept in Git — upload them on the Media page.

## Brand

`#001D4A` deep navy · `#00A1E9` primary blue · `#FFFFFF` · Source Sans (Source Sans 3, the current release of Source Sans Pro, bundled locally so it works offline).
Official logo: `frontend/src/assets/brand/logo.svg` (navy, for white backgrounds) and `logo-white.svg` (reversed).
Up to two salespeople (name + photo) are set per session and shown on the room display under the bid.

## Server API (Phase 1B, lightweight)

`backend/api/` — plain PHP, no framework, so it deploys with the same Git branch as the frontend.
`lib/engine.php` is a 1:1 port of `frontend/src/engine/engine.ts`; same rules, same response shapes.
Implements: staff sign-in (PHP session cookie), admin/operator roles, sessions, the 8-step command protocol
(lock → idempotency → lease → version → state machine → audit event → commit), operator lease and takeover,
display pairing with hashed device tokens, whitelisted public display state, image storage in MySQL.
Real-time: the room display's heartbeat is a long poll — the server answers the moment the state changes (≈0.2 s),
which works on any PHP host without a WebSocket server. A paired screen can be moved to another session from the console.
Reports: CSV, JSON and a PDF auction report (generated in the browser with jsPDF, loaded only when used).

Tests: `node --test backend/tests/api.test.mjs` against a running server with an empty database
(see the CI workflow for the exact commands). Playwright `e2e/http.spec.ts` runs the whole flow with
three separate browser contexts (office, console, room display).
