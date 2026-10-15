# Real-Time Synchronisation

## 1. Principles

1. The database row `auction_states.state_version` is the single source of truth.
2. Broadcasts are **notifications**, not truth. Any client can always re-fetch a snapshot.
3. A client never assumes it is current; it proves it by version.
4. WebSocket "connected" ≠ display up to date. Only an **ACK of version N** proves the display rendered N.

## 2. Mutation protocol (server)

1. Authenticate; check role; check operator lease (`X-Operator-Lease` active & unexpired).
2. Idempotency: if key COMPLETED → return stored response; if PROCESSING → `425`.
3. `BEGIN; SELECT … FOR UPDATE` on `auction_states`.
4. `expected_version` must equal `state_version`, else `409 VERSION_CONFLICT` (client refetches and re-presents).
5. Apply state-machine rule; write bid row(s).
6. Append audit event(s) with `state_version = v+1`.
7. `state_version = v+1`; insert outbox row; mark idempotency COMPLETED.
8. `COMMIT`, then trigger outbox relay → broadcast.

## 3. State machine

```
Session:  NOT_STARTED ─start→ LIVE ⇄ PAUSED ; LIVE|PAUSED ─end→ ENDED
Sale:     NONE ─on_the_market→ ON_THE_MARKET
          NONE|ON_THE_MARKET ─sold→ SOLD (requires ≥1 active bid)
          NONE|ON_THE_MARKET ─passed_in→ PASSED_IN
Bids:     accepted only when session LIVE and sale ∈ {NONE, ON_THE_MARKET}
          amount > current (strict)
Sold/Passed-in: allowed from LIVE or PAUSED; auto-ends the session.
```

**Public status** (display) is derived:

| session \ sale | NONE | ON_THE_MARKET | SOLD | PASSED_IN |
|---|---|---|---|---|
| NOT_STARTED | NOT_STARTED | — | — | — |
| LIVE | LIVE | ON_THE_MARKET | — | — |
| PAUSED | PAUSED | PAUSED | — | — |
| ENDED | (ENDED→ shows last) | — | SOLD | PASSED_IN |

`CONNECTION_LOST` / `RECONNECTING` are **client-local** overlays, never server states.

## 4. Display client algorithm

```
state: appliedVersion = 0, lastMsgAt
on connect / reconnect / visibilitychange / every 10s while healthy:
    snapshot = GET /display/state  → apply(snapshot)
on message(v, payload):
    if v <= appliedVersion: ignore (stale/duplicate)
    elif v == appliedVersion + 1: apply(payload)
    else: gap → GET /display/state → apply
apply(s): render s; appliedVersion = s.version; POST /display/ack {v}
every 2s: POST /display/heartbeat {appliedVersion}; on failure count++
health:
    no successful heartbeat/message for ≥5s → CONNECTION_LOST banner over a dimmed bid
    reconnecting → RECONNECTING banner; exponential backoff 0.5,1,2,4,8 … max 15s ± 20% jitter
    WebSocket down but HTTP ok → poll /display/state every 2s (still "live")
```

Display never shows bid previews — it only ever receives committed public state.

## 5. Console health indicators

| Indicator | Source | Rule |
|---|---|---|
| CLOUD | console heartbeat to `/health` every 2s | OFFLINE after 5 s without success |
| ROOM DISPLAY | device `last_heartbeat_at` via staff channel | DISCONNECTED if > 5 s old |
| STATE | `device.last_acked_version == state.state_version` | OUT OF SYNC otherwise (grace 2 s) |
| APPLIED VERSION | `device.last_acked_version` | shown as `v18 / v18` |
| LEASE | renew every 5 s, TTL 15 s | EXPIRING at < 5 s remaining |

## 6. Outbox relay

- Poll `auction_outbox WHERE published_at IS NULL ORDER BY id LIMIT 100` (also triggered immediately after commit).
- Broadcast; on success set `published_at`. On failure increment `attempts`, backoff.
- At-least-once delivery → clients dedupe by version (§4).
- If relay is down entirely, displays still converge through HTTP polling.

## 7. Phase 1A simulation

`MockServer` runs in the Staff Console tab and holds state in `localStorage` (survives reload).  
`BroadcastChannel('gl-auction')` carries `state.updated`, `display.heartbeat`, `display.ack` between tabs, so a console window and a display window behave like two computers. A fault-injection panel can drop, delay, duplicate or reorder messages and "pull the cable" on either side.
