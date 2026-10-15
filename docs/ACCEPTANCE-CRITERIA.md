# Acceptance Criteria

Format: Given / When / Then. ✅ = covered by Phase 1A prototype (mock engine). ⏳ = later phase.

## Bid input
- ✅ AC-1 Given input `1275K`, `1275k`, `1275 K`, `1.275M`, `1.275m`, or `1275000`, when parsed, then the amount is exactly 127,500,000 cents.
- ✅ AC-2 Given `-5K`, `$1M`, `1..2M`, `1.2.3`, `1.2345K`, `abc`, `0`, `1e6`, empty, or > $100M, then parsing fails with a specific error and Enter does nothing.
- ✅ AC-3 Given a current bid of $1,275,000, when the operator previews $1,270,000, then the preview shows "Must be higher than current bid" and Confirm is disabled.

## Confirmation flow
- ✅ AC-4 Given a valid preview, the display does not change until Confirm succeeds.
- ✅ AC-5 Given Confirm is pressed twice quickly, then exactly one bid is recorded.
- ✅ AC-6 Given a request committed but the response is lost, when the console retries, then it queries the idempotency key and does not create a second bid.

## State
- ✅ AC-7 Session Status and Sale Status are separate fields in every state payload.
- ✅ AC-8 Sold is rejected when there are no active bids.
- ✅ AC-9 Bids are rejected when PAUSED, NOT_STARTED, ENDED, SOLD or PASSED_IN.
- ✅ AC-10 Undo requires a reason, marks the bid REVERSED, and the previous active bid becomes current.

## Display
- ✅ AC-11 The display payload contains only whitelisted fields; reserve, notes, reasons and operator data are absent (unit test enumerates forbidden keys).
- ✅ AC-12 Given the display misses version N, when N+1 arrives, then it fetches a snapshot and ends at N+1.
- ✅ AC-13 Given no messages/heartbeat for 5 s, the display shows CONNECTION LOST and dims the bid.
- ✅ AC-14 Given a stale (older) version arrives, the display ignores it.
- ✅ AC-15 Console shows ROOM DISPLAY CONNECTED/DISCONNECTED and STATE SYNCED/OUT OF SYNC driven by display heartbeat + ACK.

## Operator lock
- ✅ AC-16 A second console tab cannot submit while another holds the lease; it can request admin takeover with a reason, which is audited.
- ⏳ AC-17 Server rejects writes with an expired lease (Phase 1B).

## Audit
- ✅ AC-18 Every mutation appends an event with session ID, sequence, type, previous/new state, operator, server timestamp, state version, reason.
- ✅ AC-19 No bid or event is ever deleted; corrections are new events.

## Offline (Phase 1E)
- ⏳ AC-20 With cloud offline, provisional bids persist across reload in IndexedDB and are marked NOT CLOUD CONFIRMED.
- ⏳ AC-21 Reconciliation requires admin approval per record and never overwrites cloud bids.

## Security (Phase 1B/1C)
- ⏳ AC-22 Display token receives 403 on every staff route.
- ⏳ AC-23 Pairing codes expire after 5 min and are single-use.

## Performance
- ⏳ AC-24 Confirm → display render p95 ≤ 1 s on venue 4G.
