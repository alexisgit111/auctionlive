<?php
/**
 * Golden Links Auction Live — API core: config, database, JSON I/O, errors, time.
 * Plain PHP 8.1+ with PDO (MySQL in production, SQLite for local tests). No framework.
 */
defined('AUCTION_API') or exit;

final class ApiError extends Exception
{
    public function __construct(
        public string $errCode,
        string $message,
        public int $status = 400,
        public ?array $details = null,
    ) {
        parent::__construct($message);
    }
}

// ───────────────────────── config ─────────────────────────
function cfg(): array
{
    static $cfg = null;
    if ($cfg !== null) return $cfg;
    $candidates = array_filter([
        getenv('AUCTION_CONFIG') ?: null,
        // Cloudways: <app>/private_html is outside the web root
        dirname(__DIR__, 3) . '/private_html/auction-live-config.php',
        dirname(__DIR__) . '/config.local.php',
    ]);
    foreach ($candidates as $file) {
        if (is_file($file)) {
            $c = require $file;
            if (is_array($c)) return $cfg = $c;
        }
    }
    throw new ApiError('NOT_CONFIGURED', 'Server is not configured yet: database settings file is missing.', 503);
}

// ───────────────────────── time / ids ─────────────────────────
function now_ms(): int
{
    return (int) floor(microtime(true) * 1000);
}

function iso(?int $ms = null): string
{
    $ms ??= now_ms();
    $sec = intdiv($ms, 1000);
    return gmdate('Y-m-d\TH:i:s', $sec) . sprintf('.%03dZ', $ms % 1000);
}

function iso_ms(?string $iso): int
{
    if (!$iso) return 0;
    $t = DateTime::createFromFormat('Y-m-d\TH:i:s.v\Z', $iso, new DateTimeZone('UTC'));
    return $t ? (int) $t->format('Uv') : 0;
}

/** Sortable 26-char id (ULID-like). */
function ulid(): string
{
    static $alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    $t = now_ms();
    $time = '';
    for ($i = 0; $i < 10; $i++) {
        $time = $alphabet[$t % 32] . $time;
        $t = intdiv($t, 32);
    }
    $rand = '';
    $bytes = random_bytes(16);
    for ($i = 0; $i < 16; $i++) $rand .= $alphabet[ord($bytes[$i]) % 32];
    return $time . $rand;
}

function uuid4(): string
{
    $b = random_bytes(16);
    $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
    $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
}

// ───────────────────────── database ─────────────────────────
function db(): PDO
{
    static $pdo = null;
    if ($pdo) return $pdo;
    $c = cfg()['db'] ?? null;
    if (!$c || empty($c['dsn'])) throw new ApiError('NOT_CONFIGURED', 'Database DSN missing in config.', 503);
    $c['dsn'] = trim((string) $c['dsn']);
    if (!preg_match('/^(mysql|sqlite):/', $c['dsn']))
        throw new ApiError('NOT_CONFIGURED', "Config 'dsn' must start with mysql: — e.g. mysql:host=localhost;dbname=YOURDB;charset=utf8mb4", 503);
    if (str_starts_with($c['dsn'], 'mysql:') && !preg_match('/(^|[;:])dbname=[^;]+/', $c['dsn']))
        throw new ApiError('NOT_CONFIGURED', "Config 'dsn' has no dbname= — e.g. mysql:host=localhost;dbname=YOURDB;charset=utf8mb4", 503);
    try {
        $pdo = new PDO($c['dsn'], isset($c['user']) ? trim((string) $c['user']) : null, $c['pass'] ?? null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
    } catch (PDOException $e) {
        error_log('[auction] DB connect failed: ' . $e->getMessage());
        // Say *why* without revealing any credentials.
        $raw = $e->getMessage();
        $code = (int) ($e->errorInfo[1] ?? 0);
        if (!$code && preg_match('/\[(\d{4})\]/', $raw, $m)) $code = (int) $m[1];
        $placeholder = str_contains($c['dsn'] . ($c['user'] ?? '') . ($c['pass'] ?? ''), 'YOUR_');
        $why = match (true) {
            $placeholder => 'the config file still contains the example values (YOUR_DB_NAME / YOUR_DB_USERNAME / YOUR_DB_PASSWORD)',
            $code === 1045 => 'MySQL rejected the username or password (error 1045)',
            $code === 1044 => 'this MySQL user has no access to that database (error 1044)',
            $code === 1049 => 'the database name was not found (error 1049)',
            $code === 2002, $code === 2005 => "cannot reach the MySQL host — use host=localhost (error $code)",
            str_contains($raw, 'could not find driver') => 'the PHP pdo_mysql extension is not enabled',
            str_contains(strtolower($raw), 'invalid data source name') => "the 'dsn' line is not in the right format — it must look like mysql:host=localhost;dbname=YOURDB;charset=utf8mb4",
            // PDO messages never contain the password; the username is fine to show to an admin.
            default => 'MySQL said: ' . preg_replace('/^SQLSTATE\[\w+\]\s*/', '', $raw),
        };
        throw new ApiError('SERVICE_UNAVAILABLE', "Cannot connect to the database: $why.", 503);
    }
    if (is_sqlite()) {
        $pdo->exec('PRAGMA foreign_keys = ON');
        $pdo->exec('PRAGMA busy_timeout = 5000');
        $pdo->exec('PRAGMA journal_mode = WAL');
    } else {
        $pdo->exec("SET time_zone = '+00:00'");
    }
    ensure_schema($pdo);
    return $pdo;
}

function is_sqlite(): bool
{
    return str_starts_with(cfg()['db']['dsn'] ?? '', 'sqlite:');
}

function q(string $sql, array $params = []): PDOStatement
{
    $st = db()->prepare($sql);
    $st->execute($params);
    return $st;
}

function one(string $sql, array $params = []): ?array
{
    $r = q($sql, $params)->fetch();
    return $r === false ? null : $r;
}

/** Serialised transaction. MySQL: InnoDB + SELECT … FOR UPDATE inside; SQLite: BEGIN IMMEDIATE. */
function tx(callable $fn): mixed
{
    $pdo = db();
    if (is_sqlite()) $pdo->exec('BEGIN IMMEDIATE');
    else $pdo->beginTransaction();
    try {
        $r = $fn();
        if (is_sqlite()) $pdo->exec('COMMIT');
        else $pdo->commit();
        return $r;
    } catch (Throwable $e) {
        try {
            if (is_sqlite()) $pdo->exec('ROLLBACK');
            elseif ($pdo->inTransaction()) $pdo->rollBack();
        } catch (Throwable) {
        }
        throw $e;
    }
}

function for_update(): string
{
    return is_sqlite() ? '' : ' FOR UPDATE';
}

const SCHEMA_VERSION = '1';

function ensure_schema(PDO $pdo): void
{
    try {
        $v = $pdo->query("SELECT v FROM meta WHERE k = 'schema'")->fetchColumn();
        if ($v === SCHEMA_VERSION) return;
    } catch (PDOException) {
        // tables do not exist yet
    }
    $engine = is_sqlite() ? '' : ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
    $stmts = [
        "CREATE TABLE IF NOT EXISTS meta (k VARCHAR(64) PRIMARY KEY, v VARCHAR(255) NOT NULL)$engine",
        "CREATE TABLE IF NOT EXISTS users (
            id VARCHAR(32) PRIMARY KEY, email VARCHAR(190) NOT NULL UNIQUE, name VARCHAR(120) NOT NULL,
            role VARCHAR(16) NOT NULL, password_hash VARCHAR(255) NOT NULL, active INT NOT NULL DEFAULT 1,
            created_at VARCHAR(32) NOT NULL)$engine",
        "CREATE TABLE IF NOT EXISTS auction_sessions (
            id VARCHAR(32) PRIMARY KEY, data LONGTEXT NOT NULL, created_at VARCHAR(32) NOT NULL)$engine",
        "CREATE TABLE IF NOT EXISTS auction_states (
            session_id VARCHAR(32) PRIMARY KEY, data LONGTEXT NOT NULL, state_version BIGINT NOT NULL DEFAULT 0)$engine",
        "CREATE TABLE IF NOT EXISTS auction_bids (
            id VARCHAR(32) PRIMARY KEY, session_id VARCHAR(32) NOT NULL, seq INT NOT NULL,
            amount_cents BIGINT NOT NULL, status VARCHAR(16) NOT NULL, supersedes_bid_id VARCHAR(32) NULL,
            operator_id VARCHAR(32) NOT NULL, idempotency_key VARCHAR(64) NOT NULL, source VARCHAR(16) NOT NULL,
            created_at VARCHAR(32) NOT NULL, UNIQUE (session_id, seq))$engine",
        "CREATE TABLE IF NOT EXISTS auction_events (
            session_id VARCHAR(32) NOT NULL, seq INT NOT NULL, type VARCHAR(40) NOT NULL, data LONGTEXT NOT NULL,
            created_at VARCHAR(32) NOT NULL, PRIMARY KEY (session_id, seq))$engine",
        "CREATE TABLE IF NOT EXISTS auction_leases (
            session_id VARCHAR(32) PRIMARY KEY, data LONGTEXT NOT NULL)$engine",
        "CREATE TABLE IF NOT EXISTS auction_devices (
            id VARCHAR(32) PRIMARY KEY, session_id VARCHAR(32) NOT NULL, label VARCHAR(120) NOT NULL,
            token_hash CHAR(64) NOT NULL UNIQUE, approved_by VARCHAR(32) NOT NULL, approved_at VARCHAR(32) NOT NULL,
            revoked_at VARCHAR(32) NULL, last_heartbeat_at VARCHAR(32) NULL, last_acked_version BIGINT NOT NULL DEFAULT -1,
            last_acked_at VARCHAR(32) NULL)$engine",
        "CREATE TABLE IF NOT EXISTS auction_pairings (
            id VARCHAR(64) PRIMARY KEY, code VARCHAR(12) NOT NULL, created_at VARCHAR(32) NOT NULL,
            expires_at VARCHAR(32) NOT NULL, status VARCHAR(16) NOT NULL, session_id VARCHAR(32) NULL,
            device_id VARCHAR(32) NULL, pending_token VARCHAR(128) NULL)$engine",
        "CREATE TABLE IF NOT EXISTS auction_idempotency (
            idem_key VARCHAR(64) PRIMARY KEY, user_id VARCHAR(32) NOT NULL, request_hash CHAR(64) NOT NULL,
            status VARCHAR(16) NOT NULL, response LONGTEXT NULL, created_at VARCHAR(32) NOT NULL)$engine",
        "CREATE TABLE IF NOT EXISTS auction_images (
            id CHAR(32) PRIMARY KEY, mime VARCHAR(40) NOT NULL, data LONGBLOB NOT NULL, created_at VARCHAR(32) NOT NULL)$engine",
    ];
    foreach ($stmts as $s) $pdo->exec($s);
    // indexes (ignore "already exists")
    foreach ([
        'CREATE INDEX idx_bids_session ON auction_bids (session_id, status, seq)',
        'CREATE INDEX idx_devices_session ON auction_devices (session_id)',
        'CREATE INDEX idx_pairings_code ON auction_pairings (code, status)',
    ] as $s) {
        try {
            $pdo->exec($s);
        } catch (PDOException) {
        }
    }
    $pdo->prepare(is_sqlite()
        ? "INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', ?)"
        : "REPLACE INTO meta (k, v) VALUES ('schema', ?)")->execute([SCHEMA_VERSION]);
}

// ───────────────────────── HTTP I/O ─────────────────────────
function body(): array
{
    static $b = null;
    if ($b !== null) return $b;
    $raw = file_get_contents('php://input') ?: '';
    if ($raw === '') return $b = [];
    $j = json_decode($raw, true);
    if (!is_array($j)) throw new ApiError('VALIDATION_FAILED', 'Request body must be JSON', 400);
    return $b = $j;
}

function out(mixed $data, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, private, max-age=0');
    header('Pragma: no-cache');
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function fail(ApiError $e): never
{
    out(['error' => ['code' => $e->errCode, 'message' => $e->getMessage(), 'details' => $e->details]], $e->status);
}

function str_field(array $a, string $k, int $max = 500): string
{
    $v = $a[$k] ?? '';
    if (!is_string($v)) throw new ApiError('VALIDATION_FAILED', "$k must be text", 422);
    $v = trim($v);
    if (mb_strlen($v) > $max) throw new ApiError('VALIDATION_FAILED', "$k is too long", 422);
    return $v;
}

function jdec(?string $s): mixed
{
    return $s === null ? null : json_decode($s, true);
}

function jenc(mixed $v): string
{
    return json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}
