<?php
/**
 * Auction Live — server configuration.
 *
 * Copy this file to ONE of these locations (first one found wins):
 *   1. <application>/private_html/auction-live-config.php   ← recommended on Cloudways (outside the web root)
 *   2. public_html/api/config.local.php
 * and fill in the values from Cloudways → Application → Access Details → MySQL Access.
 *
 * Never commit the real file to Git.
 */
return [
    'db' => [
        'dsn'  => 'mysql:host=localhost;dbname=YOUR_DB_NAME;charset=utf8mb4',
        'user' => 'YOUR_DB_USERNAME',
        'pass' => 'YOUR_DB_PASSWORD',
    ],

    // Long random text. Needed once, to create the first admin account on the Setup page.
    'setup_key' => 'CHANGE-ME-to-a-long-random-phrase',

    // Session cookie only over HTTPS (keep true in production).
    'secure_cookies' => true,

    // Room display "instant push": the server holds each display request for up to this long and
    // answers the moment the auction changes. Each room display uses one PHP worker while waiting.
    // 0 = plain 1-second polling.
    'display_wait_ms' => 3500,
];
