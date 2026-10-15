# Failure Recovery Runbook

For each failure: **Detection · User-facing warning · Safe behaviour · Recovery · Audit.**

| # | Failure | Detection | Warning | Safe behaviour | Recovery | Audit |
|---|---|---|---|---|---|---|
| 1 | WebSocket disconnect (display) | socket `close`/no msg + heartbeat | Display: none if HTTP polling healthy; else RECONNECTING | Switch to 2 s HTTP polling | Backoff reconnect → snapshot | device health log |
| 2 | Cloud API outage | console `/health` fails ≥5 s | Console: red **CLOUD OFFLINE**; offer OFFLINE SCRIBING | Cloud bid entry disabled | Auto-retry; on success refetch state; reconcile offline records | `OFFLINE_IMPORTED` per record |
| 3 | Display computer disconnect | no device heartbeat > 5 s | Console: **ROOM DISPLAY DISCONNECTED** | Auction may continue — operator decides; auctioneer informed | Display reconnects → snapshot → ACK | device heartbeat gap recorded |
| 4 | Staff laptop disconnect | console heartbeat fails | Console: CLOUD OFFLINE; Display unchanged (still shows last confirmed bid, marked live because display itself is healthy) | No cloud mutations; lease will expire at 15 s | Reconnect → re-acquire lease (same user auto) → refetch | `OPERATOR_ACQUIRED` |
| 5 | Duplicate bid submission | same idempotency key | none (transparent) | Server returns stored response | — | single event only |
| 6 | Concurrent operator actions | lease check / version conflict | "Another operator holds control" / "State changed — review" | Reject with 423/409 | Refetch; re-present | takeover events |
| 7 | Out-of-order events | `v <= applied` | none | Ignore | — | — |
| 8 | Missed events | `v > applied+1` | brief "SYNCING" on console only | Display holds last good frame | Snapshot fetch | — |
| 9 | Display version mismatch | ACK ≠ current for > 2 s | Console: **STATE OUT OF SYNC** | Operator may ask auctioneer to pause | Console "Force resync" sends `resync` command | `DISPLAY_RESYNC_REQUESTED` |
| 10 | Browser reload | — | — | Console: state from server; draft input lost (intended). Display: snapshot on boot | — | — |
| 11 | Server restart | 5xx / socket drop | CLOUD OFFLINE briefly | Pending request → query idempotency status | Outbox relay re-sends unpublished | — |
| 12 | Failed broadcast after commit | outbox row unpublished | none | Committed data safe | Relay retries; displays converge via polling/snapshot | outbox attempts |
| 13 | Lost HTTP response after commit | timeout on mutation | Console: "Confirming…" | **Do not resend blindly** — `GET /idempotency/{key}` | If COMPLETED → apply stored response; if unknown → resend same key | none extra |
| 14 | Expired / revoked display credential | 401 from display API | Display: full-screen "Display not paired — contact staff" | Shows no auction data | Re-pair via `/auction/pair` | `DISPLAY_REVOKED` |
| 15 | Operator lease expired mid-auction | renew fails / 423 | Console: **CONTROL LOST** modal | Inputs disabled | Re-acquire (if free) or admin takeover | `OPERATOR_TAKEOVER` with reason |

## Operational checklist (auction day)

1. 30 min before: open console, acquire control, confirm CLOUD ONLINE.
2. Open display PC → `/auction/pair` → approve code on console → verify ROOM DISPLAY CONNECTED, STATE SYNCED.
3. Enter a test bid on a **test session**, confirm display, then end the test session.
4. Keep a paper scribe sheet as last-resort backup until Phase 1F acceptance is signed off.
5. If CLOUD OFFLINE during bidding: tell auctioneer, switch to OFFLINE SCRIBING, keep recording; reconcile after.
