# API Contract — v1

Base: `https://{host}/api/v1` · JSON only · TLS only.

## Conventions

- Auth: `Authorization: Bearer <sanctum token>`.
- Every **mutation** requires `Idempotency-Key: <uuid v4>` and body field `expected_version`.
- Mutations on a live session also require `X-Operator-Lease: <lease_token>`.
- Money in requests and responses: `*_cents` as **string** of digits (avoids JS number precision issues) plus a display string.

### Error shape

```json
{ "error": { "code": "VERSION_CONFLICT", "message": "State has changed.", "details": { "current_version": 42 } } }
```

| HTTP | code |
|---|---|
| 400 | `INVALID_AMOUNT`, `VALIDATION_FAILED` |
| 401 | `UNAUTHENTICATED` |
| 403 | `FORBIDDEN`, `DISPLAY_TOKEN_NOT_ALLOWED` |
| 404 | `NOT_FOUND` |
| 409 | `VERSION_CONFLICT`, `BID_NOT_HIGHER`, `INVALID_TRANSITION`, `IDEMPOTENCY_KEY_REUSED` |
| 423 | `LEASE_REQUIRED`, `LEASE_EXPIRED`, `LEASE_HELD_BY_OTHER` |
| 425 | `REQUEST_IN_PROGRESS` (same key still processing) |
| 503 | `SERVICE_UNAVAILABLE` |

## Staff endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/sessions` | list |
| POST | `/sessions` | create |
| GET/PATCH/DELETE | `/sessions/{id}` | delete only if `NOT_STARTED` and no events |
| GET | `/sessions/{id}/state` | full staff state (includes reserve) |
| POST | `/sessions/{id}/lease` | acquire → `{lease_token, expires_at}` |
| POST | `/sessions/{id}/lease/renew` | every 5 s; lease TTL 15 s |
| DELETE | `/sessions/{id}/lease` | release |
| POST | `/sessions/{id}/lease/takeover` | admin, requires `reason` |
| POST | `/sessions/{id}/start` | |
| POST | `/sessions/{id}/pause` · `/resume` | |
| POST | `/sessions/{id}/bids` | `{amount_cents, expected_version}` |
| POST | `/sessions/{id}/bids/{bidId}/correct` | `{amount_cents, reason, expected_version}` |
| POST | `/sessions/{id}/bids/undo` | `{bid_id, reason, expected_version}` — must be latest active bid |
| POST | `/sessions/{id}/on-the-market` | |
| POST | `/sessions/{id}/sold` | `{confirm: true}`; requires ≥1 bid |
| POST | `/sessions/{id}/passed-in` | `{confirm: true}` |
| POST | `/sessions/{id}/end` | |
| GET | `/sessions/{id}/bids` | history incl. reversed/corrected |
| GET | `/sessions/{id}/events?after_seq=` | audit stream |
| GET | `/idempotency/{key}` | status of an earlier request |
| GET | `/sessions/{id}/devices` | paired displays + health |
| POST | `/pairing/approve` | `{code, session_id, label}` |
| DELETE | `/devices/{id}` | revoke |
| POST | `/sessions/{id}/offline-records` | upload provisional batch |
| GET | `/sessions/{id}/offline-records` | |
| POST | `/offline-records/{id}/decision` | admin: `{decision: IMPORTED|DISCARDED, reason}` |

### Example — submit bid

```http
POST /api/v1/sessions/01J…/bids
Idempotency-Key: 9b1d…
X-Operator-Lease: 4c2e…
{ "amount_cents": "127500000", "expected_version": 17 }
```
`201`
```json
{ "bid": { "id": "01J…", "seq": 6, "amount_cents": "127500000", "amount_display": "$1,275,000" },
  "state": { "state_version": 18, "session_status": "LIVE", "sale_status": "NONE", "current_bid_cents": "127500000" } }
```
A retry with the same key and same body returns the stored `201` response. Same key, different body → `409 IDEMPOTENCY_KEY_REUSED`.

## Display endpoints (display token only)

| Method | Path | Notes |
|---|---|---|
| POST | `/pairing/request` | unauthenticated, rate-limited → `{code, pairing_id, expires_at}` |
| GET | `/pairing/{pairing_id}` | poll → `PENDING` / `APPROVED {display_token, session_id}` (token returned once) / `EXPIRED` |
| GET | `/display/state` | public snapshot |
| POST | `/display/heartbeat` | `{appliedVersion, sessionId, wait}` — with `wait: true` a long poll: returns `{serverVersion, sessionId}` as soon as the version or the screen's session changes, else after `display_wait_ms` (3.5 s) |
| POST | `/display/ack` | `{applied_version}` after render |

Staff device routes (PHP API): `GET /devices` (active screens on all sessions, with `sessionTitle` / `sessionAddress`),
`POST /devices/{id}/move {sessionId}` (point a paired screen at another session; audited as `DISPLAY_MOVED_OUT` / `DISPLAY_MOVED_IN`),
`POST /devices/{id}/revoke`.

### Public state payload (the **only** shape a display ever receives)

```json
{
  "session_id": "01J…",
  "state_version": 18,
  "session_status": "LIVE",
  "sale_status": "ON_THE_MARKET",
  "public_status": "ON_THE_MARKET",
  "current_bid_display": "$1,275,000",
  "current_bid_cents": "127500000",
  "property": { "address_line": "12 Example Road", "suburb": "Flat Bush", "city": "Auckland", "hero_image_url": "…" },
  "brand": { "name": "Harcourts Golden Links" },
  "server_time": "2026-10-16T01:02:03.456Z"
}
```

## Broadcast channels

| Channel | Auth | Event | Payload |
|---|---|---|---|
| `private-display.session.{id}` | display token | `state.updated` | public payload |
| `private-staff.session.{id}` | staff token | `state.updated`, `device.health`, `lease.changed` | staff payload |
