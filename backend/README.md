# Backend — PHP API

Plain PHP 8.1+ with PDO. MySQL in production (Cloudways), SQLite for automated tests.

- `api/index.php` — router (`/api/index.php?r=/route`)
- `api/lib/engine.php` — auction state machine, 1:1 port of `frontend/src/engine/engine.ts`
- `api/lib/handlers.php` — routes: auth, users, sessions, commands, lease, pairing, display, images
- `api/config.example.php` — copy to `<app>/private_html/auction-live-config.php` on the server
- `tests/api.test.mjs` — integration tests (`node --test`) against a running server
- `dev/router.php` — local `php -S` router that behaves like Cloudways Nginx

Deployment: `../docs/DEPLOY-CLOUDWAYS.md`.
