<?php
/**
 * Single-page-app fallback for Cloudways.
 * Cloudways' Nginx sends any path that is not a real file (e.g. /auction/control)
 * to index.php. We answer with the built app shell; React Router takes it from there.
 * Real files (assets, images) are still served directly by Nginx.
 */
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-cache, no-store, must-revalidate');
header('X-Content-Type-Options: nosniff');
readfile(__DIR__ . '/index.html');
