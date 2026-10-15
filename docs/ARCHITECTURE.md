# Architecture

## 1. Overview

```
                   ┌───────────────────────── Cloudways ─────────────────────────┐
                   │                                                               │
 Staff Laptop      │   Nginx (TLS)                                                 │
 ┌─────────────┐   │   ├── /           → React SPA (static, PWA)                   │
 │ Staff       │──HTTPS──►/api/v1/*   → Laravel (PHP-FPM)                         │
 │ Console     │   │   │                  ├── AuctionCommandService (transactions)│
 │ (React PWA) │◄─WSS─┐│                  ├── PublicStateSerializer (whitelist)    │
 │ IndexedDB   │   │  ││                  └── Outbox writer                        │
 └─────────────┘   │  ││                                                           │
                   │  │└── MySQL 8  (sessions, bids, events, outbox, leases …)     │
 Room Display PC   │  │                                                            │
 ┌─────────────┐   │  │   Outbox Relay worker (Supervisor)                         │
 │ Display     │◄─WSS─┴── Reverb  /  managed Pusher-compatible provider ◄──────────┘
 │ (React)     │──HTTPS──► /api/v1/display/*  (display token, read-only)
 └─────────────┘   └───────────────────────────────────────────────────────────────┘
```

One authoritative backend. Two independent clients that never talk to each other directly.

## 2. Components

| Component | Responsibility |
|---|---|
| **React SPA** | One build, routes for console, display, sessions, pair, reports. Vite + TS + Tailwind + React Router + TanStack Query. |
| **Laravel API** | REST v1, Sanctum auth (staff tokens and display tokens with distinct abilities). |
| **AuctionCommandService** | The only code path that mutates auction state. Implements the 8-step mutation protocol (REALTIME.md §2). |
| **PublicStateSerializer** | Builds the display payload from an explicit whitelist. Unit-tested against a "forbidden field" list. |
| **Outbox Relay** | Long-running worker: reads `auction_outbox` rows with `published_at IS NULL`, broadcasts, marks published. At-least-once. |
| **Broadcaster** | Laravel Reverb if Cloudways can host it (needs Supervisor + a reachable WS port/proxy); otherwise Pusher/Ably/Soketi-cloud. Chosen by `BROADCAST_CONNECTION`. |
| **Polling fallback** | Display polls `GET /display/state` every 2 s when the WebSocket is down. This also guarantees progress if the broadcaster is entirely unavailable. |

## 3. Cloudways constraints (to verify in Phase 1F)

Cloudways is managed PHP hosting. **Do not assume** long-running processes are available. Verify:

1. Supervisor access for `php artisan reverb:start` and `php artisan auction:outbox-relay`.
2. Whether Nginx can proxy `wss://` upgrade to Reverb's port.
3. Cron availability (`schedule:run` every minute) as a fallback relay trigger.

**Decision rule:** if (1) or (2) fail, use a managed Pusher-compatible provider for broadcast and run the outbox relay inline after commit + via cron sweep. The display's HTTP polling fallback keeps the system correct regardless.

## 4. Trust boundaries

| Principal | Token ability | Can reach |
|---|---|---|
| Staff (operator/admin) | `staff:*` | `/api/v1/*` except `/display/*` |
| Display device | `display:read` scoped to `session_id` | `/api/v1/display/state`, `/display/heartbeat`, `/display/ack`, private channel `display.session.{id}` |

Display tokens are rejected by every staff route by middleware, not by convention.

## 5. Frontend structure

```
frontend/src/
├─ lib/            money.ts (K/M parser, cents), format.ts, ids.ts
├─ engine/         types.ts, engine.ts (state machine), publicState.ts (whitelist)
│                  mockServer.ts (Phase 1A in-browser authority), transport.ts
├─ hooks/          useAuction, useHealth, useKeyboard
├─ components/     brand/, console/, display/, ui/
└─ pages/          Sessions, Control, Display, Pair, Reports
```

The `transport` interface is the seam: Phase 1A plugs in `MockTransport` (BroadcastChannel + localStorage), Phase 1B/1C swaps in `HttpTransport` + `EchoTransport` without touching UI code.

## 6. Backend structure (Phase 1B)

```
backend/
├─ app/Domain/Auction/   Commands/, Events/, StateMachine.php, Money.php
├─ app/Http/Controllers/Api/V1/
├─ app/Http/Middleware/  EnsureOperatorLease, EnsureDisplayScope, Idempotency
├─ app/Serializers/      PublicDisplayState.php
├─ app/Console/Commands/ OutboxRelay.php
└─ database/migrations/
```
