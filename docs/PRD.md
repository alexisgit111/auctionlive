# Golden Links Auction Live — Product Requirements Document

**Owner:** Harcourts Golden Links, Auckland  
**Status:** Draft v0.1 (Phase 1A)  
**Scope:** In-room auction support. **Not** an online bidding platform.

---

## 1. Problem

At an in-room auction the auctioneer accepts bids verbally. Today the current bid is shown (if at all) by hand, and the record of bids is a paper scribe sheet. This is slow, error-prone, and leaves no reliable audit trail.

## 2. Goal

Give one authorised staff operator a fast, safe console to record each verbally accepted bid, push the confirmed bid to a large room display within a second, and produce a tamper-evident electronic scribe record of the whole auction.

### Success measures

| Measure | Target |
|---|---|
| Operator time from hearing a bid to confirmed display | ≤ 3 s typical |
| Confirmed bid → room display render (healthy network) | ≤ 1 s p95 |
| Bids lost or duplicated | 0 |
| Auctions with complete audit trail | 100 % |
| Display showing stale data without a visible warning | Never |

## 3. Users

| Role | Description | Can |
|---|---|---|
| **Operator** | Staff member running the console in the room | Hold operator lease, record bids, change auction status |
| **Admin** | Senior staff / auction manager | Everything Operator can, plus session setup, display pairing approval, operator takeover, offline reconciliation approval, reports |
| **Room Display** | A paired device (not a person) | Read public display state for one session only |
| **Viewer** (future) | Read-only staff | Reports only |

Buyers and the public never log in.

## 4. Views

| Route | Purpose |
|---|---|
| `/auction/sessions` | Create/edit auction sessions and properties |
| `/auction/control` | Staff Console (desktop-first) |
| `/auction/display/:sessionId` | Fullscreen 16:9 room display |
| `/auction/pair` | Display pairing (device side and staff approval side) |
| `/auction/reports` | Scribe record, audit events, exports |

## 5. Functional requirements

### 5.1 Session setup
- FR-1 Create a session with: property address, hero image, auction date/time, auctioneer name, default increment, opening bid (optional), reserve (private, optional).
- FR-2 Sessions have a **Session Status** (`NOT_STARTED`, `LIVE`, `PAUSED`, `ENDED`) and a separate **Sale Status** (`NONE`, `ON_THE_MARKET`, `SOLD`, `PASSED_IN`).

### 5.2 Staff Console
- FR-3 Show current accepted bid, next-bid preview, bid count, session & sale status.
- FR-4 Smart K/M input: `1275K`, `1275k`, `1275 K`, `1.275M`, `1.275m`, `1275000` all parse to NZD $1,275,000.00.
- FR-5 Reject invalid input: negatives, unsupported symbols, more than one decimal point, more than 2 decimal places of cents after scaling, values above the safety ceiling (default $100,000,000), zero.
- FR-6 Large calculator keypad with K, M, `.`, backspace, clear.
- FR-7 Quick increment buttons (e.g. +1K, +5K, +10K, +25K, +50K, +100K) and a configurable default increment.
- FR-8 Keyboard / numpad shortcuts (see §7).
- FR-9 Bid flow: INPUT → PREVIEW → CONFIRM → SERVER VALIDATION → COMMIT → PUSH → DISPLAY. The display never shows previews.
- FR-10 A new bid must be strictly greater than the current accepted bid (unless the session has no bids yet).
- FR-11 Submit button disabled while a request is pending; each mutation carries an idempotency key.
- FR-12 Undo last bid and correct a bid — both require a reason and are append-only.
- FR-13 Start, pause, resume, end auction; set On the Market; confirm Sold; confirm Passed In. Sold / Passed In require a confirmation step.
- FR-14 Bid history list, newest first, showing reversed/corrected entries struck through.
- FR-15 Health strip: CLOUD, ROOM DISPLAY, STATE, APPLIED VERSION, OPERATOR LEASE, OFFLINE MODE.

### 5.3 Room Display
- FR-16 Fullscreen 16:9, readable from 20 m: branding, property image, address, current confirmed bid, public status.
- FR-17 Shows a clear connection warning when unhealthy; never presents stale data as live.
- FR-18 Uses a whitelisted public-state payload only (no reserve, notes, reasons, buyer info).

### 5.4 Pairing
- FR-19 Display shows a short-lived pairing code (6 chars, 5 min expiry). Staff enter/approve it. Backend issues a revocable display credential scoped to one session, read-only.

### 5.5 Scribing & audit
- FR-20 Every state change appends an immutable audit event (see DATABASE.md).
- FR-21 Reports: chronological scribe sheet, CSV/JSON export, printable PDF (Phase 1E).

### 5.6 Offline scribing (Phase 1E)
- FR-22 On loss of backend connectivity the console enters OFFLINE SCRIBING MODE: cloud submission disabled, provisional records saved to IndexedDB, marked NOT CLOUD CONFIRMED, exportable.
- FR-23 On reconnect, an admin reviews and explicitly imports or discards each provisional record. Cloud-confirmed records are never overwritten.

## 6. Non-functional requirements

- NFR-1 Monetary values stored and compared as integer cents (`BIGINT`). No floats in authoritative paths.
- NFR-2 TLS everywhere; Sanctum tokens; display credentials hashed at rest.
- NFR-3 Server-authoritative state with monotonically increasing `state_version`.
- NFR-4 WCAG AA contrast, visible focus states, full keyboard operation of the console.
- NFR-5 No decorative motion during live bidding (bid-change highlight ≤ 300 ms, disabled under `prefers-reduced-motion`).
- NFR-6 All configuration via environment variables.

## 7. Keyboard map (Staff Console)

| Key | Action |
|---|---|
| `0–9`, `.` | Type amount |
| `K` / `M` | Thousand / million suffix |
| `Backspace` | Delete last char |
| `Esc` | Clear input / cancel confirm |
| `Enter` | Preview → Confirm (second Enter commits) |
| `+` (numpad) | Load "current + default increment" into input |
| `F1…F6` | Quick increments |
| `Ctrl+Z` | Undo last bid (opens reason dialog) |
| `P` (when input empty) | Pause / resume |

## 8. Brand

| Token | Value |
|---|---|
| Deep navy | `#001D4A` |
| Primary blue | `#00A1E9` |
| White | `#FFFFFF` |
| Typeface | Source Sans Pro (Source Sans 3) |

Supporting neutrals: dark surface `#101827`, text `#E5E7EB`. Status colours used sparingly: success `#22C55E`, warning `#F59E0B`, danger `#EF4444`.

## 9. Out of scope (Phase 1)

Online/remote bidding, buyer accounts, bidder registration, payments, multi-property auction day management, OBS overlays, LAN fallback / server election.

## 10. Phases

| Phase | Content |
|---|---|
| **1A** | Frontend prototype + control workflow against an in-browser mock engine |
| 1B | Laravel API, MySQL, Sanctum, authoritative bid engine |
| 1C | Independent display, pairing, real-time push |
| 1D | Heartbeat, ACK, auto-reconnect, full re-sync |
| 1E | Audit UI, corrections, offline scribing, reconciliation |
| 1F | Integration & fault-injection testing, Cloudways staging, acceptance |
