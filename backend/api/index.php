<?php
/**
 * Golden Links Auction Live — API entry point.
 *
 * Routes are passed as ?r=/path so the API works on any Cloudways stack
 * (Nginx-only stacks do not route /api/xyz to this file).
 */
declare(strict_types=1);
const AUCTION_API = true;
/** Bump together with API_VERSION in frontend/src/engine/api.ts whenever routes change. */
const API_VERSION = 4;

require __DIR__ . '/lib/core.php';
require __DIR__ . '/lib/engine.php';
require __DIR__ . '/lib/auth.php';
require __DIR__ . '/lib/handlers.php';
require __DIR__ . '/lib/media.php';

ini_set('display_errors', '0');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = '/' . trim((string) ($_GET['r'] ?? ''), '/');

/** [method, pattern, handler, needsApiHeader] — patterns use {id} placeholders. */
$routes = [
    ['GET', '/health', fn() => ['ok' => true, 'serverNow' => iso(), 'apiVersion' => API_VERSION]],
    ['GET', '/setup/status', 'h_setup_status'],
    ['POST', '/setup/admin', 'h_setup_admin'],

    ['POST', '/auth/login', 'h_login'],
    ['POST', '/auth/logout', 'h_logout'],
    ['GET', '/auth/me', 'h_me'],
    ['POST', '/auth/password', 'h_change_own_password'],

    ['GET', '/users', 'h_users_list'],
    ['POST', '/users', 'h_users_create'],
    ['POST', '/users/{id}', 'h_users_update'],

    ['GET', '/sessions', 'h_sessions_list'],
    ['POST', '/sessions', 'h_sessions_create'],
    ['POST', '/sessions/{id}', 'h_sessions_update'],
    ['GET', '/sessions/{id}/view', 'h_staff_view'],
    ['GET', '/sessions/{id}/events', 'h_events'],
    ['GET', '/sessions/{id}/bids', 'h_bids'],
    ['POST', '/sessions/{id}/execute', 'h_execute'],
    ['POST', '/sessions/{id}/lease', 'h_lease_acquire'],
    ['POST', '/sessions/{id}/lease/renew', 'h_lease_renew'],
    ['POST', '/sessions/{id}/lease/release', 'h_lease_release'],
    ['POST', '/sessions/{id}/lease/takeover', 'h_lease_takeover'],
    ['GET', '/idempotency/{id}', 'h_idempotency'],

    ['POST', '/pairing/approve', 'h_pairing_approve'],
    ['POST', '/devices/{id}/revoke', 'h_device_revoke'],
    ['GET', '/devices', 'h_devices_list'],
    ['POST', '/devices/{id}/move', 'h_device_move'],

    ['POST', '/display/pairing', 'h_display_pairing_request'],
    ['GET', '/display/pairing/{id}', 'h_display_pairing_poll'],
    ['GET', '/display/state', 'h_display_state'],
    ['POST', '/display/heartbeat', 'h_display_heartbeat'],
    ['POST', '/display/ack', 'h_display_ack'],

    ['GET', '/media/settings', 'h_media_settings_get'],
    ['POST', '/media/settings', 'h_media_settings_set'],
    ['POST', '/media/upload/start', 'h_media_upload_start'],
    ['POST', '/media/upload/chunk', 'h_media_upload_chunk'],
    ['POST', '/media/upload/finish', 'h_media_upload_finish'],
    ['GET', '/media/{id}', 'h_media_get'],
    ['HEAD', '/media/{id}', 'h_media_get'],

    ['POST', '/images', 'h_image_upload'],
    ['GET', '/images/{id}', 'h_image_get'],
];

try {
    require_api_header();
    foreach ($routes as [$m, $pattern, $handler]) {
        if ($m !== $method) continue;
        $re = '#^' . preg_replace('#\{id\}#', '([A-Za-z0-9_-]{1,64})', $pattern) . '$#';
        if (preg_match($re, $path, $mm)) {
            array_shift($mm);
            out($handler(...$mm));
        }
    }
    throw new ApiError('NOT_FOUND', "No route for $method $path", 404);
} catch (ApiError $e) {
    fail($e);
} catch (Throwable $e) {
    error_log('[auction] ' . $e);
    fail(new ApiError('SERVER_ERROR', 'Unexpected server error', 500));
}
