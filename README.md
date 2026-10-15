# Golden Links Auction Live

In-room auction control, room display and electronic scribing for Harcourts Golden Links.
**Not** an online bidding platform.

```
AUCTION LIVE/
├─ docs/        PRD, architecture, database, API, real-time, failure recovery, acceptance criteria
├─ frontend/    React + TypeScript + Vite + Tailwind (Phase 1A prototype — runs today)
└─ backend/     Laravel API (Phase 1B — not started)
```

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
> of the **same browser on the same computer** for now. Phase 1B/1C replaces the mock with the Laravel API + WebSockets,
> after which they run on separate computers. Nothing connects to any Golden Links system.

### Tests

```bash
npm test             # 69 unit tests: K/M parsing, state machine, idempotency, lease, audit, display whitelist, sync
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

## Brand

`#001D4A` deep navy · `#00A1E9` primary blue · `#FFFFFF` · Source Sans (Source Sans 3, the current release of Source Sans Pro, bundled locally so it works offline).
Official logo: `frontend/src/assets/brand/logo.svg` (navy, for white backgrounds) and `logo-white.svg` (reversed).
Auctioneer name and photo are set per session (Sessions → Edit) and shown on the room display under the bid.

## Next: Phase 1B

Laravel 11 API + MySQL migrations per `docs/DATABASE.md`, Sanctum auth, `AuctionCommandService` porting
`frontend/src/engine/engine.ts` 1:1 (its tests become the shared contract), idempotency middleware, lease middleware,
public display serializer, outbox. See `docs/ARCHITECTURE.md` §3 for the Cloudways WebSocket checks to do first.
