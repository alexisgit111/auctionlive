<?php
/** Staff login (PHP session cookie) and room-display device tokens. */
defined('AUCTION_API') or exit;

function start_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) return;
    $secure = (bool) (cfg()['secure_cookies'] ?? (($_SERVER['HTTPS'] ?? '') === 'on' || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https'));
    session_name('GLAUCTION');
    session_set_cookie_params([
        'lifetime' => 60 * 60 * 12, // a working day
        'path' => '/',
        'secure' => $secure,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();
}

function public_user(array $u): array
{
    return ['id' => $u['id'], 'name' => $u['name'], 'email' => $u['email'], 'role' => $u['role'], 'active' => (bool) $u['active']];
}

function current_user(): ?array
{
    start_session();
    $id = $_SESSION['uid'] ?? null;
    if (!$id) return null;
    $u = one('SELECT * FROM users WHERE id = ?', [$id]);
    if (!$u || !$u['active']) {
        $_SESSION = [];
        return null;
    }
    // Release the session lock early so parallel requests from the console are not serialised.
    session_write_close();
    return $u;
}

function require_staff(): array
{
    $u = current_user();
    if (!$u) throw new ApiError('UNAUTHENTICATED', 'Please sign in', 401);
    return $u;
}

function require_admin(): array
{
    $u = require_staff();
    if ($u['role'] !== 'admin') throw new ApiError('FORBIDDEN', 'Admin only', 403);
    return $u;
}

/** Simple CSRF guard: browsers cannot add custom headers cross-site without a CORS preflight, which we never allow. */
function require_api_header(): void
{
    if (in_array($_SERVER['REQUEST_METHOD'] ?? 'GET', ['GET', 'HEAD'], true)) return;
    if (($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'auction-live')
        throw new ApiError('FORBIDDEN', 'Missing request header', 403);
}

function display_device(): array
{
    $token = $_SERVER['HTTP_X_DISPLAY_TOKEN'] ?? '';
    if ($token === '') throw new ApiError('UNAUTHENTICATED', 'Display is not paired', 401);
    $d = one('SELECT * FROM auction_devices WHERE token_hash = ?', [hash('sha256', $token)]);
    if (!$d || $d['revoked_at']) throw new ApiError('UNAUTHENTICATED', 'Display credential is invalid or revoked', 401);
    return $d;
}

function validate_password(string $p): void
{
    if (mb_strlen($p) < 8) throw new ApiError('VALIDATION_FAILED', 'Password must be at least 8 characters', 422);
}

function validate_email(string $e): string
{
    $e = strtolower(trim($e));
    if (!filter_var($e, FILTER_VALIDATE_EMAIL)) throw new ApiError('VALIDATION_FAILED', 'Enter a valid email address', 422);
    return $e;
}
