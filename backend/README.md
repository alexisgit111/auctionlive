# Backend — Phase 1B (not started)

Laravel 11 + MySQL 8 + Sanctum + Reverb (or managed Pusher-compatible provider).

Planned layout and contracts: `../docs/ARCHITECTURE.md` §6, `../docs/DATABASE.md`, `../docs/API.md`, `../docs/REALTIME.md`.

Port `../frontend/src/engine/engine.ts` (state machine) and `../frontend/src/lib/money.ts` (K/M parsing, integer cents)
first, and mirror their unit tests in PHPUnit so frontend and backend share one rule set.

Before building: verify on Cloudways staging whether Supervisor + WebSocket proxying are available (ARCHITECTURE.md §3).
No connection to any live Golden Links database without explicit approval.
