<?php
/**
 * Local test server that behaves like Cloudways' Nginx:
 * real files are served as-is, everything else goes to /index.php (the app shell).
 *   php -S localhost:8080 -t <public_html dir> backend/dev/router.php
 */
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$file = $_SERVER['DOCUMENT_ROOT'] . $path;
if ($path !== '/' && is_file($file)) return false;
require $_SERVER['DOCUMENT_ROOT'] . '/index.php';
