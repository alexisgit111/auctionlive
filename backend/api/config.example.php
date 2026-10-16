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
        'dsn'  => 'tqcqbafmuq',
        'user' => 'tqcqbafmuq',
        'pass' => 'BBsWkZV7f5',
    ],

    // Long random text. Needed once, to create the first admin account on the Setup page.
    'setup_key' => 'c9453c3f50154f2ea9296e611bc0679970b5301d15e8427980d9991952def94f',

    // Session cookie only over HTTPS (keep true in production).
    'secure_cookies' => true,
];
