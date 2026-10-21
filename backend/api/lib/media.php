<?php
/**
 * Room screen media — the same for every session:
 *   welcome image (stored like property photos, in auction_images)
 *   welcome music + pause music (files on disk, uploaded in small chunks, streamed with Range support)
 * The active choice is kept in meta('room_media') as ids.
 */
defined('AUCTION_API') or exit;

const MEDIA_CHUNK = 512 * 1024;            // well under any web server's request-size limit
const MEDIA_MAX_BYTES = 40 * 1024 * 1024;  // a long MP3 at 192 kbps is ~10 MB
const MEDIA_AUDIO_MIME = ['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/ogg'];

/** Where music files live. Cloudways: <app>/private_html/auction-media (outside the web root, untouched by Git). */
function media_dir(): string
{
    $c = cfg();
    $dir = $c['media_dir'] ?? null;
    if (!$dir) {
        $private = dirname(__DIR__, 3) . '/private_html';
        $dir = is_dir($private) ? $private . '/auction-media' : dirname(__DIR__, 2) . '/auction-media-store';
    }
    if (!is_dir($dir) && !@mkdir($dir, 0775, true))
        throw new ApiError('SERVICE_UNAVAILABLE', 'Cannot create the media folder on the server', 503);
    if (!is_file("$dir/.htaccess")) @file_put_contents("$dir/.htaccess", "Require all denied\n");
    return $dir;
}

function media_path(string $id, bool $part = false): string
{
    if (!preg_match('/^[0-9a-f]{32}$/', $id)) throw new ApiError('NOT_FOUND', 'Media not found', 404);
    return media_dir() . "/$id" . ($part ? '.part' : '.bin');
}

function media_url(string $id): string
{
    return '/api/index.php?r=/media/' . $id;
}

// ───────────────────────── settings ─────────────────────────
function room_media_ids(): array
{
    $r = one("SELECT v FROM meta WHERE k = 'room_media'");
    $j = $r ? json_decode($r['v'], true) : null;
    return [
        'wi' => is_array($j) ? ($j['wi'] ?? null) : null,
        'wm' => is_array($j) ? ($j['wm'] ?? null) : null,
        'pm' => is_array($j) ? ($j['pm'] ?? null) : null,
    ];
}

function save_room_media_ids(array $ids): void
{
    $v = json_encode(['wi' => $ids['wi'], 'wm' => $ids['wm'], 'pm' => $ids['pm']]);
    q(is_sqlite() ? "INSERT OR REPLACE INTO meta (k, v) VALUES ('room_media', ?)" : "REPLACE INTO meta (k, v) VALUES ('room_media', ?)", [$v]);
}

/** What the room display gets (URLs only). Cached per request. */
function room_media_public(): array
{
    static $m = null;
    if ($m !== null) return $m;
    $ids = room_media_ids();
    return $m = [
        'welcomeImage' => $ids['wi'] ? '/api/index.php?r=/images/' . $ids['wi'] : null,
        'welcomeMusic' => $ids['wm'] ? media_url($ids['wm']) : null,
        'pauseMusic' => $ids['pm'] ? media_url($ids['pm']) : null,
    ];
}

function media_file_row(?string $id): ?array
{
    if (!$id) return null;
    $r = one("SELECT * FROM auction_media WHERE id = ? AND status = 'READY'", [$id]);
    return $r ? ['id' => $r['id'], 'url' => media_url($r['id']), 'name' => $r['name'], 'size' => (int) $r['size']] : null;
}

function h_media_settings_get(): array
{
    require_staff();
    $ids = room_media_ids();
    return [
        'welcomeImage' => $ids['wi'] ? '/api/index.php?r=/images/' . $ids['wi'] : null,
        'welcomeMusic' => media_file_row($ids['wm']),
        'pauseMusic' => media_file_row($ids['pm']),
    ];
}

function h_media_settings_set(): array
{
    require_admin();
    $b = body();
    $ids = room_media_ids();
    if (array_key_exists('welcomeImage', $b)) {
        $ref = $b['welcomeImage'];
        if ($ref === null) $ids['wi'] = null;
        elseif (is_string($ref) && preg_match('#/images/([0-9a-f]{32})$#', $ref, $m) && one('SELECT id FROM auction_images WHERE id = ?', [$m[1]]))
            $ids['wi'] = $m[1];
        else throw new ApiError('VALIDATION_FAILED', 'Unknown welcome image', 422);
    }
    foreach (['welcomeMusic' => 'wm', 'pauseMusic' => 'pm'] as $key => $short) {
        if (!array_key_exists($key, $b)) continue;
        $id = $b[$key];
        if ($id === null) $ids[$short] = null;
        elseif (is_string($id) && media_file_row($id)) $ids[$short] = $id;
        else throw new ApiError('VALIDATION_FAILED', 'Unknown music file', 422);
    }
    save_room_media_ids($ids);
    // Paired screens notice the change through their heartbeat (it reports the current media) — no
    // state-version bump, so an operator mid-auction never gets a version conflict from this.
    return h_media_settings_get();
}

// ───────────────────────── chunked upload ─────────────────────────
function h_media_upload_start(): array
{
    $u = require_admin();
    $b = body();
    $name = str_field($b, 'name', 190) ?: 'music';
    $size = (int) ($b['size'] ?? 0);
    $mime = strtolower((string) ($b['mime'] ?? ''));
    if ($size <= 0) throw new ApiError('VALIDATION_FAILED', 'Empty file', 422);
    if ($size > MEDIA_MAX_BYTES) throw new ApiError('VALIDATION_FAILED', 'File is too large (max 40 MB)', 422);
    if ($mime === '' && preg_match('/\.mp3$/i', $name)) $mime = 'audio/mpeg';
    if (!in_array($mime, MEDIA_AUDIO_MIME, true)) throw new ApiError('VALIDATION_FAILED', 'Upload an MP3, M4A, WAV or OGG audio file', 422);
    $id = bin2hex(random_bytes(16));
    file_put_contents(media_path($id, true), '');
    q("INSERT INTO auction_media (id, kind, name, mime, size, status, created_by, created_at) VALUES (?, 'music', ?, ?, ?, 'UPLOADING', ?, ?)",
        [$id, $name, $mime === 'audio/mp3' ? 'audio/mpeg' : $mime, $size, $u['id'], iso()]);
    return ['uploadId' => $id, 'chunkSize' => MEDIA_CHUNK];
}

function h_media_upload_chunk(): array
{
    require_admin();
    $b = body();
    $id = (string) ($b['uploadId'] ?? '');
    $index = (int) ($b['index'] ?? -1);
    $r = one("SELECT * FROM auction_media WHERE id = ? AND status = 'UPLOADING'", [$id]);
    if (!$r) throw new ApiError('NOT_FOUND', 'Upload not found', 404);
    $data = base64_decode((string) ($b['data'] ?? ''), true);
    if ($data === false || $data === '' || strlen($data) > MEDIA_CHUNK) throw new ApiError('VALIDATION_FAILED', 'Bad chunk', 422);
    $offset = $index * MEDIA_CHUNK;
    if ($index < 0 || $offset + strlen($data) > (int) $r['size']) throw new ApiError('VALIDATION_FAILED', 'Chunk out of range', 422);
    $path = media_path($id, true);
    clearstatcache(true, $path);
    $have = filesize($path);
    if ($offset > $have) throw new ApiError('VALIDATION_FAILED', 'Chunks must be sent in order', 409);
    // Idempotent: a retried chunk overwrites from its own offset.
    $fh = fopen($path, 'c+b');
    ftruncate($fh, $offset);
    fseek($fh, $offset);
    fwrite($fh, $data);
    fclose($fh);
    return ['received' => $offset + strlen($data)];
}

function h_media_upload_finish(): array
{
    require_admin();
    $id = (string) (body()['uploadId'] ?? '');
    $r = one("SELECT * FROM auction_media WHERE id = ? AND status = 'UPLOADING'", [$id]);
    if (!$r) throw new ApiError('NOT_FOUND', 'Upload not found', 404);
    $part = media_path($id, true);
    clearstatcache(true, $part);
    if (filesize($part) !== (int) $r['size']) throw new ApiError('VALIDATION_FAILED', 'Upload incomplete — please try again', 422);
    $head = (string) file_get_contents($part, false, null, 0, 16);
    $isAudio = str_starts_with($head, 'ID3')                                        // MP3 with tags
        || (strlen($head) > 1 && ord($head[0]) === 0xFF && (ord($head[1]) & 0xE0) === 0xE0) // MP3/AAC frame
        || substr($head, 4, 4) === 'ftyp'                                           // M4A
        || (str_starts_with($head, 'RIFF') && substr($head, 8, 4) === 'WAVE')
        || str_starts_with($head, 'OggS');
    if (!$isAudio) {
        @unlink($part);
        q("DELETE FROM auction_media WHERE id = ?", [$id]);
        throw new ApiError('VALIDATION_FAILED', 'That file is not an audio file', 422);
    }
    rename($part, media_path($id));
    q("UPDATE auction_media SET status = 'READY' WHERE id = ?", [$id]);
    return media_file_row($id);
}

// ───────────────────────── streaming (public, like images) ─────────────────────────
function h_media_get(string $id): never
{
    $r = one("SELECT * FROM auction_media WHERE id = ? AND status = 'READY'", [$id]);
    $path = $r ? media_path($id) : '';
    if (!$r || !is_file($path)) throw new ApiError('NOT_FOUND', 'Media not found', 404);
    $size = filesize($path);
    $start = 0;
    $end = $size - 1;
    $status = 200;
    if (preg_match('/^bytes=(\d*)-(\d*)$/', $_SERVER['HTTP_RANGE'] ?? '', $m)) {
        if ($m[1] === '' && $m[2] !== '') {
            $start = max(0, $size - (int) $m[2]);
        } else {
            $start = (int) $m[1];
            if ($m[2] !== '') $end = min($end, (int) $m[2]);
        }
        if ($start > $end || $start >= $size) {
            http_response_code(416);
            header("Content-Range: bytes */$size");
            exit;
        }
        $status = 206;
    }
    while (ob_get_level()) ob_end_clean();
    http_response_code($status);
    header('Content-Type: ' . $r['mime']);
    header('Accept-Ranges: bytes');
    header('Content-Length: ' . ($end - $start + 1));
    if ($status === 206) header("Content-Range: bytes $start-$end/$size");
    header('Cache-Control: public, max-age=31536000, immutable');
    header('ETag: "' . $id . '"');
    header('X-Content-Type-Options: nosniff');
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'HEAD') exit;
    $fh = fopen($path, 'rb');
    fseek($fh, $start);
    $left = $end - $start + 1;
    while ($left > 0 && !feof($fh) && !connection_aborted()) {
        $buf = fread($fh, min(65536, $left));
        echo $buf;
        flush();
        $left -= strlen($buf);
    }
    fclose($fh);
    exit;
}
