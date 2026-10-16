<?php
/**
 * Route handlers. Response shapes match frontend/src/engine/types.ts exactly,
 * so the React app can switch between the in-browser mock and this API.
 */
defined('AUCTION_API') or exit;

const LEASE_TTL_MS = 15_000;
const PAIRING_TTL_MS = 5 * 60_000;
const MAX_SALESPEOPLE = 2;

// ───────────────────────── loaders ─────────────────────────
function load_session(string $id): array
{
    $r = one('SELECT data FROM auction_sessions WHERE id = ?', [$id]);
    if (!$r) throw new ApiError('NOT_FOUND', 'Session not found', 404);
    return jdec($r['data']);
}

function load_state(string $sid, bool $lock = false): array
{
    $r = one('SELECT data FROM auction_states WHERE session_id = ?' . ($lock ? for_update() : ''), [$sid]);
    if (!$r) throw new ApiError('NOT_FOUND', 'Session not found', 404);
    return jdec($r['data']);
}

function save_state(array $s): void
{
    q('UPDATE auction_states SET data = ?, state_version = ? WHERE session_id = ?', [jenc($s), $s['stateVersion'], $s['sessionId']]);
}

function bid_row(array $r): array
{
    return [
        'id' => $r['id'],
        'sessionId' => $r['session_id'],
        'seq' => (int) $r['seq'],
        'amountCents' => (string) $r['amount_cents'],
        'status' => $r['status'],
        'supersedesBidId' => $r['supersedes_bid_id'],
        'operatorId' => $r['operator_id'],
        'idempotencyKey' => $r['idempotency_key'],
        'source' => $r['source'],
        'createdAt' => $r['created_at'],
    ];
}

function load_bids(string $sid): array
{
    return array_map('bid_row', q('SELECT * FROM auction_bids WHERE session_id = ? ORDER BY seq', [$sid])->fetchAll());
}

function device_row(array $d): array
{
    return [
        'id' => $d['id'],
        'sessionId' => $d['session_id'],
        'label' => $d['label'],
        'approvedBy' => $d['approved_by'],
        'approvedAt' => $d['approved_at'],
        'revokedAt' => $d['revoked_at'],
        'lastHeartbeatAt' => $d['last_heartbeat_at'],
        'lastAckedVersion' => (int) $d['last_acked_version'],
        'lastAckedAt' => $d['last_acked_at'],
    ];
}

function active_lease(string $sid): ?array
{
    $r = one('SELECT data FROM auction_leases WHERE session_id = ?', [$sid]);
    if (!$r) return null;
    $l = jdec($r['data']);
    if (!empty($l['releasedAt'])) return null;
    if (iso_ms($l['expiresAt']) <= now_ms()) return null;
    return $l;
}

function save_lease(array $l): void
{
    $exists = one('SELECT session_id FROM auction_leases WHERE session_id = ?', [$l['sessionId']]);
    if ($exists) q('UPDATE auction_leases SET data = ? WHERE session_id = ?', [jenc($l), $l['sessionId']]);
    else q('INSERT INTO auction_leases (session_id, data) VALUES (?, ?)', [$l['sessionId'], jenc($l)]);
}

/** Audit event that does not change auction state (lease, pairing). Caller holds the state lock. */
function append_meta_event(array &$state, string $type, ?string $operatorId, ?string $reason = null, ?array $data = null): void
{
    $state['eventSeq'] += 1;
    $snap = eng_snapshot($state);
    $ev = [
        'sessionId' => $state['sessionId'], 'seq' => $state['eventSeq'], 'type' => $type,
        'previousState' => $snap, 'newState' => $snap, 'operatorId' => $operatorId, 'serverTimestamp' => iso(),
        'stateVersion' => $state['stateVersion'], 'reason' => $reason, 'idempotencyKey' => null, 'data' => $data,
    ];
    insert_event($ev);
    save_state($state);
}

function insert_event(array $ev): void
{
    q('INSERT INTO auction_events (session_id, seq, type, data, created_at) VALUES (?, ?, ?, ?, ?)',
        [$ev['sessionId'], $ev['seq'], $ev['type'], jenc($ev), $ev['serverTimestamp']]);
}

// ───────────────────────── setup & auth ─────────────────────────
function h_setup_status(): array
{
    $n = (int) one('SELECT COUNT(*) AS n FROM users')['n'];
    return ['needsAdmin' => $n === 0];
}

function h_setup_admin(): array
{
    $b = body();
    $key = (string) (cfg()['setup_key'] ?? '');
    if ($key === '' || !hash_equals($key, (string) ($b['setupKey'] ?? ''))) {
        usleep(500_000);
        throw new ApiError('FORBIDDEN', 'Setup key is incorrect', 403);
    }
    return tx(function () use ($b) {
        if ((int) one('SELECT COUNT(*) AS n FROM users')['n'] > 0) throw new ApiError('FORBIDDEN', 'Setup is already complete', 403);
        $email = validate_email((string) ($b['email'] ?? ''));
        $name = str_field($b, 'name', 120);
        if ($name === '') throw new ApiError('VALIDATION_FAILED', 'Name is required', 422);
        $pw = (string) ($b['password'] ?? '');
        validate_password($pw);
        $id = ulid();
        q('INSERT INTO users (id, email, name, role, password_hash, active, created_at) VALUES (?,?,?,?,?,1,?)',
            [$id, $email, $name, 'admin', password_hash($pw, PASSWORD_DEFAULT), iso()]);
        return ['ok' => true];
    });
}

function h_login(): array
{
    $b = body();
    $email = strtolower(trim((string) ($b['email'] ?? '')));
    $pw = (string) ($b['password'] ?? '');
    $u = one('SELECT * FROM users WHERE email = ?', [$email]);
    if (!$u || !$u['active'] || !password_verify($pw, $u['password_hash'])) {
        usleep(700_000); // slow down guessing
        throw new ApiError('UNAUTHENTICATED', 'Email or password is incorrect', 401);
    }
    start_session();
    session_regenerate_id(true);
    $_SESSION['uid'] = $u['id'];
    return ['user' => public_user($u)];
}

function h_logout(): array
{
    start_session();
    $_SESSION = [];
    session_destroy();
    return ['ok' => true];
}

function h_me(): array
{
    return ['user' => public_user(require_staff())];
}

// ───────────────────────── users (admin) ─────────────────────────
function h_users_list(): array
{
    $me = require_staff();
    $rows = q('SELECT * FROM users ORDER BY name')->fetchAll();
    if ($me['role'] !== 'admin') return array_map(fn($u) => ['id' => $u['id'], 'name' => $u['name']], $rows);
    return array_map('public_user', $rows);
}

function h_users_create(): array
{
    require_admin();
    $b = body();
    $email = validate_email((string) ($b['email'] ?? ''));
    $name = str_field($b, 'name', 120);
    if ($name === '') throw new ApiError('VALIDATION_FAILED', 'Name is required', 422);
    $role = ($b['role'] ?? 'operator') === 'admin' ? 'admin' : 'operator';
    $pw = (string) ($b['password'] ?? '');
    validate_password($pw);
    if (one('SELECT id FROM users WHERE email = ?', [$email])) throw new ApiError('VALIDATION_FAILED', 'That email is already in use', 422);
    $id = ulid();
    q('INSERT INTO users (id, email, name, role, password_hash, active, created_at) VALUES (?,?,?,?,?,1,?)',
        [$id, $email, $name, $role, password_hash($pw, PASSWORD_DEFAULT), iso()]);
    return public_user(one('SELECT * FROM users WHERE id = ?', [$id]));
}

function h_users_update(string $id): array
{
    $me = require_admin();
    $u = one('SELECT * FROM users WHERE id = ?', [$id]);
    if (!$u) throw new ApiError('NOT_FOUND', 'User not found', 404);
    $b = body();
    if (array_key_exists('name', $b)) {
        $name = str_field($b, 'name', 120);
        if ($name === '') throw new ApiError('VALIDATION_FAILED', 'Name is required', 422);
        q('UPDATE users SET name = ? WHERE id = ?', [$name, $id]);
    }
    if (array_key_exists('role', $b)) {
        if ($id === $me['id'] && $b['role'] !== 'admin') throw new ApiError('VALIDATION_FAILED', 'You cannot remove your own admin role', 422);
        q('UPDATE users SET role = ? WHERE id = ?', [$b['role'] === 'admin' ? 'admin' : 'operator', $id]);
    }
    if (array_key_exists('active', $b)) {
        if ($id === $me['id'] && !$b['active']) throw new ApiError('VALIDATION_FAILED', 'You cannot deactivate yourself', 422);
        q('UPDATE users SET active = ? WHERE id = ?', [$b['active'] ? 1 : 0, $id]);
    }
    if (!empty($b['password'])) {
        validate_password((string) $b['password']);
        q('UPDATE users SET password_hash = ? WHERE id = ?', [password_hash((string) $b['password'], PASSWORD_DEFAULT), $id]);
    }
    return public_user(one('SELECT * FROM users WHERE id = ?', [$id]));
}

function h_change_own_password(): array
{
    $me = require_staff();
    $b = body();
    if (!password_verify((string) ($b['currentPassword'] ?? ''), $me['password_hash']))
        throw new ApiError('VALIDATION_FAILED', 'Current password is incorrect', 422);
    validate_password((string) ($b['newPassword'] ?? ''));
    q('UPDATE users SET password_hash = ? WHERE id = ?', [password_hash((string) $b['newPassword'], PASSWORD_DEFAULT), $me['id']]);
    return ['ok' => true];
}

// ───────────────────────── sessions ─────────────────────────
function clean_session_input(array $i): array
{
    $title = str_field($i, 'title', 190);
    $prop = is_array($i['property'] ?? null) ? $i['property'] : [];
    $address = str_field($prop, 'addressLine', 190);
    if ($title === '') $title = $address;
    if ($title === '') throw new ApiError('VALIDATION_FAILED', 'Title is required', 422);
    if ($address === '') throw new ApiError('VALIDATION_FAILED', 'Property address is required', 422);
    $inc = (string) ($i['defaultIncrementCents'] ?? '');
    if (!preg_match('/^[1-9][0-9]{0,13}$/', $inc)) throw new ApiError('VALIDATION_FAILED', 'Default increment must be a positive amount', 422);
    $reserve = $i['reserveCents'] ?? null;
    if ($reserve !== null && !preg_match('/^[1-9][0-9]{0,13}$/', (string) $reserve))
        throw new ApiError('VALIDATION_FAILED', 'Reserve must be a positive amount', 422);
    $people = is_array($i['salespeople'] ?? null) ? $i['salespeople'] : [];
    if (count($people) > MAX_SALESPEOPLE) throw new ApiError('VALIDATION_FAILED', 'At most 2 salespeople can be shown', 422);
    $num = function ($v) {
        if ($v === null || $v === '') return null;
        if (!is_numeric($v) || $v < 0) throw new ApiError('VALIDATION_FAILED', 'Property numbers must be positive', 422);
        return (int) $v;
    };
    $img = function ($v) {
        if ($v === null || $v === '') return null;
        if (!is_string($v) || strlen($v) > 300 || str_starts_with($v, 'data:'))
            throw new ApiError('VALIDATION_FAILED', 'Images must be uploaded first', 422);
        return $v;
    };
    return [
        'title' => $title,
        'scheduledAt' => str_field($i, 'scheduledAt', 40),
        'auctioneerName' => str_field($i, 'auctioneerName', 120),
        'defaultIncrementCents' => $inc,
        'reserveCents' => $reserve === null ? null : (string) $reserve,
        'internalNotes' => str_field($i, 'internalNotes', 2000),
        'property' => [
            'addressLine' => $address,
            'suburb' => str_field($prop, 'suburb', 120),
            'city' => str_field($prop, 'city', 120),
            'heroImage' => $img($prop['heroImage'] ?? null),
            'bedrooms' => $num($prop['bedrooms'] ?? null),
            'bathrooms' => $num($prop['bathrooms'] ?? null),
            'parking' => $num($prop['parking'] ?? null),
            'landAreaM2' => $num($prop['landAreaM2'] ?? null),
            'floorAreaM2' => $num($prop['floorAreaM2'] ?? null),
            'badge' => str_field($prop, 'badge', 24),
        ],
        'salespeople' => array_values(array_map(fn($p) => [
            'name' => str_field(is_array($p) ? $p : [], 'name', 80),
            'photo' => $img(is_array($p) ? ($p['photo'] ?? null) : null),
        ], $people)),
    ];
}

function h_sessions_list(): array
{
    require_staff();
    $rows = q('SELECT s.data AS sdata, st.data AS tdata FROM auction_sessions s JOIN auction_states st ON st.session_id = s.id ORDER BY s.created_at DESC')->fetchAll();
    return array_map(fn($r) => ['session' => jdec($r['sdata']), 'state' => jdec($r['tdata'])], $rows);
}

function h_sessions_create(): array
{
    $u = require_admin();
    $clean = clean_session_input(body());
    return tx(function () use ($clean, $u) {
        $id = ulid();
        $now = iso();
        $s = ['id' => $id] + $clean + ['createdAt' => $now, 'createdBy' => $u['id']];
        q('INSERT INTO auction_sessions (id, data, created_at) VALUES (?, ?, ?)', [$id, jenc($s), $now]);
        q('INSERT INTO auction_states (session_id, data, state_version) VALUES (?, ?, 0)', [$id, jenc(eng_initial_state($id, $now))]);
        return $s;
    });
}

function h_sessions_update(string $id): array
{
    require_admin();
    $clean = clean_session_input(body());
    return tx(function () use ($id, $clean) {
        $s = load_session($id);
        $s = array_merge($s, $clean);
        q('UPDATE auction_sessions SET data = ? WHERE id = ?', [jenc($s), $id]);
        return $s;
    });
}

function h_staff_view(string $sid): array
{
    require_staff();
    $session = load_session($sid);
    $bids = load_bids($sid);
    usort($bids, fn($a, $b) => $b['seq'] <=> $a['seq']);
    return [
        'session' => $session,
        'state' => load_state($sid),
        'bids' => $bids,
        'lease' => active_lease($sid),
        'devices' => array_map('device_row', q('SELECT * FROM auction_devices WHERE session_id = ?', [$sid])->fetchAll()),
        'serverNow' => iso(),
    ];
}

function h_events(string $sid): array
{
    require_staff();
    load_session($sid);
    return array_map(fn($r) => jdec($r['data']), q('SELECT data FROM auction_events WHERE session_id = ? ORDER BY seq', [$sid])->fetchAll());
}

function h_bids(string $sid): array
{
    require_staff();
    return load_bids($sid);
}

// ───────────────────────── commands (8-step protocol) ─────────────────────────
function h_execute(string $sid): array
{
    $u = require_staff();
    $b = body();
    $cmd = is_array($b['cmd'] ?? null) ? $b['cmd'] : throw new ApiError('VALIDATION_FAILED', 'cmd required', 422);
    $key = (string) ($b['idempotencyKey'] ?? '');
    if (!preg_match('/^[0-9a-fA-F-]{16,64}$/', $key)) throw new ApiError('VALIDATION_FAILED', 'Idempotency key required', 422);
    $expected = $b['expectedVersion'] ?? null;
    if (!is_int($expected)) throw new ApiError('VALIDATION_FAILED', 'expectedVersion required', 422);
    $leaseToken = $b['leaseToken'] ?? null;
    $hash = hash('sha256', jenc(['sessionId' => $sid, 'cmd' => $cmd, 'expectedVersion' => $expected]));

    $result = tx(function () use ($sid, $u, $cmd, $key, $expected, $leaseToken, $hash) {
        // lock first so concurrent requests with the same key are serialised
        $state = load_state($sid, true);

        // 1. idempotency replay
        $prior = one('SELECT * FROM auction_idempotency WHERE idem_key = ?', [$key]);
        if ($prior) {
            if ($prior['request_hash'] !== $hash || $prior['user_id'] !== $u['id'])
                throw new ApiError('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used for a different request', 409);
            $stored = jdec($prior['response']);
            if ($prior['status'] === 'COMPLETED') return ['ok' => $stored];
            return ['err' => $stored];
        }
        $record = function (string $status, array $payload) use ($key, $u, $hash) {
            q('INSERT INTO auction_idempotency (idem_key, user_id, request_hash, status, response, created_at) VALUES (?,?,?,?,?,?)',
                [$key, $u['id'], $hash, $status, jenc($payload), iso()]);
        };

        try {
            // 2. operator lease
            $lease = active_lease($sid);
            if (!$lease) throw new ApiError('LEASE_REQUIRED', 'Take operator control first', 423);
            if ($lease['leaseToken'] !== $leaseToken || $lease['userId'] !== $u['id'])
                throw new ApiError('LEASE_HELD_BY_OTHER', $lease['userName'] . ' has operator control', 423);
            // 3. version check
            if ($state['stateVersion'] !== $expected)
                throw new ApiError('VERSION_CONFLICT', 'Auction state changed — review and try again', 409, ['currentVersion' => $state['stateVersion']]);
            // 4–6. state machine + audit event + version++
            $now = iso();
            $r = eng_apply($state, load_bids($sid), $cmd, ['operatorId' => $u['id'], 'now' => $now, 'idempotencyKey' => $key]);
            foreach ($r['changedBidIds'] as $cid) {
                foreach ($r['bids'] as $bid) if ($bid['id'] === $cid) q('UPDATE auction_bids SET status = ? WHERE id = ?', [$bid['status'], $cid]);
            }
            if ($r['bid']) {
                $nb = $r['bid'];
                q('INSERT INTO auction_bids (id, session_id, seq, amount_cents, status, supersedes_bid_id, operator_id, idempotency_key, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
                    [$nb['id'], $sid, $nb['seq'], (int) $nb['amountCents'], 'ACTIVE', $nb['supersedesBidId'], $u['id'], $key, 'CLOUD', $now]);
            }
            insert_event($r['event']);
            save_state($r['state']);
            $response = ['state' => $r['state'], 'bid' => $r['bid']];
            $record('COMPLETED', $response);
            return ['ok' => $response];
        } catch (ApiError $e) {
            // business errors are stored so a retry with the same key gets the same answer
            $payload = ['code' => $e->errCode, 'message' => $e->getMessage(), 'status' => $e->status, 'details' => $e->details];
            $record('FAILED', $payload);
            return ['err' => $payload];
        }
    });

    if (mt_rand(1, 200) === 1) q('DELETE FROM auction_idempotency WHERE created_at < ?', [iso(now_ms() - 3 * 86_400_000)]);
    if (isset($result['err'])) {
        $e = $result['err'];
        throw new ApiError($e['code'], $e['message'], $e['status'], $e['details']);
    }
    return $result['ok'];
}

function h_idempotency(string $key): array
{
    $u = require_staff();
    $r = one('SELECT * FROM auction_idempotency WHERE idem_key = ? AND user_id = ?', [$key, $u['id']]);
    if (!$r) return ['status' => 'UNKNOWN'];
    return $r['status'] === 'COMPLETED' ? ['status' => 'COMPLETED', 'response' => jdec($r['response'])] : ['status' => 'FAILED'];
}

// ───────────────────────── operator lease ─────────────────────────
function new_lease(string $sid, array $u): array
{
    $now = now_ms();
    return [
        'sessionId' => $sid, 'userId' => $u['id'], 'userName' => $u['name'], 'leaseToken' => uuid4(),
        'acquiredAt' => iso($now), 'renewedAt' => iso($now), 'expiresAt' => iso($now + LEASE_TTL_MS), 'releasedAt' => null,
    ];
}

function h_lease_acquire(string $sid): array
{
    $u = require_staff();
    return tx(function () use ($sid, $u) {
        $state = load_state($sid, true);
        $cur = active_lease($sid);
        if ($cur && $cur['userId'] !== $u['id'])
            throw new ApiError('LEASE_HELD_BY_OTHER', $cur['userName'] . ' has operator control', 423, ['holder' => $cur['userName'], 'expiresAt' => $cur['expiresAt']]);
        $l = new_lease($sid, $u);
        save_lease($l);
        append_meta_event($state, 'OPERATOR_ACQUIRED', $u['id'], null, ['reacquired' => $cur ? 1 : 0]);
        return $l;
    });
}

function h_lease_renew(string $sid): array
{
    $u = require_staff();
    $token = (string) (body()['leaseToken'] ?? '');
    return tx(function () use ($sid, $u, $token) {
        load_state($sid, true);
        $cur = active_lease($sid);
        if (!$cur || $cur['leaseToken'] !== $token || $cur['userId'] !== $u['id'])
            throw new ApiError('LEASE_EXPIRED', 'Operator control has been lost', 423);
        $cur['renewedAt'] = iso();
        $cur['expiresAt'] = iso(now_ms() + LEASE_TTL_MS);
        save_lease($cur);
        return $cur;
    });
}

function h_lease_release(string $sid): array
{
    $u = require_staff();
    $token = (string) (body()['leaseToken'] ?? '');
    return tx(function () use ($sid, $u, $token) {
        $state = load_state($sid, true);
        $cur = active_lease($sid);
        if (!$cur || $cur['leaseToken'] !== $token) return ['ok' => true];
        $cur['releasedAt'] = iso();
        save_lease($cur);
        append_meta_event($state, 'OPERATOR_RELEASED', $u['id']);
        return ['ok' => true];
    });
}

function h_lease_takeover(string $sid): array
{
    $u = require_admin();
    $reason = str_field(body(), 'reason', 500);
    if ($reason === '') throw new ApiError('VALIDATION_FAILED', 'A reason is required for takeover', 422);
    return tx(function () use ($sid, $u, $reason) {
        $state = load_state($sid, true);
        $prev = active_lease($sid);
        $l = new_lease($sid, $u);
        save_lease($l);
        append_meta_event($state, 'OPERATOR_TAKEOVER', $u['id'], $reason, ['fromUserId' => $prev['userId'] ?? null, 'fromUserName' => $prev['userName'] ?? null]);
        return $l;
    });
}

// ───────────────────────── pairing & devices ─────────────────────────
function h_pairing_approve(): array
{
    $u = require_staff();
    $b = body();
    $code = preg_replace('/[^A-Z0-9]/', '', strtoupper((string) ($b['code'] ?? '')));
    $sid = (string) ($b['sessionId'] ?? '');
    $label = str_field($b, 'label', 120) ?: 'Room display';
    return tx(function () use ($u, $code, $sid, $label) {
        $state = load_state($sid, true);
        $p = one("SELECT * FROM auction_pairings WHERE code = ? AND status = 'PENDING'", [$code]);
        if (!$p) throw new ApiError('NOT_FOUND', 'Pairing code not found or already used', 404);
        if (iso_ms($p['expires_at']) <= now_ms()) {
            q("UPDATE auction_pairings SET status = 'EXPIRED' WHERE id = ?", [$p['id']]);
            throw new ApiError('VALIDATION_FAILED', 'Pairing code has expired', 422);
        }
        $token = bin2hex(random_bytes(32));
        $id = ulid();
        $now = iso();
        q('INSERT INTO auction_devices (id, session_id, label, token_hash, approved_by, approved_at, last_acked_version) VALUES (?,?,?,?,?,?,-1)',
            [$id, $sid, $label, hash('sha256', $token), $u['id'], $now]);
        q("UPDATE auction_pairings SET status = 'APPROVED', session_id = ?, device_id = ?, pending_token = ? WHERE id = ?", [$sid, $id, $token, $p['id']]);
        append_meta_event($state, 'DISPLAY_PAIRED', $u['id'], null, ['deviceId' => $id, 'label' => $label]);
        return device_row(one('SELECT * FROM auction_devices WHERE id = ?', [$id]));
    });
}

function h_device_revoke(string $id): array
{
    $u = require_staff();
    return tx(function () use ($u, $id) {
        $d = one('SELECT * FROM auction_devices WHERE id = ?', [$id]);
        if (!$d) throw new ApiError('NOT_FOUND', 'Device not found', 404);
        $state = load_state($d['session_id'], true);
        q('UPDATE auction_devices SET revoked_at = ? WHERE id = ?', [iso(), $id]);
        append_meta_event($state, 'DISPLAY_REVOKED', $u['id'], null, ['deviceId' => $id, 'label' => $d['label']]);
        return ['ok' => true];
    });
}

function h_display_pairing_request(): array
{
    // unauthenticated; tidy up expired codes
    q("UPDATE auction_pairings SET status = 'EXPIRED' WHERE status = 'PENDING' AND expires_at < ?", [iso()]);
    q("DELETE FROM auction_pairings WHERE status IN ('EXPIRED','CLAIMED') AND created_at < ?", [iso(now_ms() - 86_400_000)]);
    $pending = (int) one("SELECT COUNT(*) AS n FROM auction_pairings WHERE status = 'PENDING'")['n'];
    if ($pending > 50) throw new ApiError('SERVICE_UNAVAILABLE', 'Too many pending pairing requests', 429);
    $alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    $code = '';
    $bytes = random_bytes(6);
    for ($i = 0; $i < 6; $i++) $code .= $alphabet[ord($bytes[$i]) % strlen($alphabet)];
    $id = uuid4();
    $now = now_ms();
    q('INSERT INTO auction_pairings (id, code, created_at, expires_at, status) VALUES (?,?,?,?,?)',
        [$id, $code, iso($now), iso($now + PAIRING_TTL_MS), 'PENDING']);
    return ['pairingId' => $id, 'code' => $code, 'expiresAt' => iso($now + PAIRING_TTL_MS)];
}

function h_display_pairing_poll(string $pid): array
{
    return tx(function () use ($pid) {
        $p = one('SELECT * FROM auction_pairings WHERE id = ?' . for_update(), [$pid]);
        if (!$p) return ['status' => 'EXPIRED'];
        if ($p['status'] === 'PENDING' && iso_ms($p['expires_at']) <= now_ms()) {
            q("UPDATE auction_pairings SET status = 'EXPIRED' WHERE id = ?", [$pid]);
            return ['status' => 'EXPIRED'];
        }
        if ($p['status'] === 'APPROVED' && $p['pending_token']) {
            // the token is handed out exactly once
            q("UPDATE auction_pairings SET status = 'CLAIMED', pending_token = NULL WHERE id = ?", [$pid]);
            return ['status' => 'APPROVED', 'token' => $p['pending_token'], 'sessionId' => $p['session_id'], 'deviceId' => $p['device_id']];
        }
        return ['status' => $p['status']];
    });
}

function h_display_state(): array
{
    $d = display_device();
    return to_public_state(load_session($d['session_id']), load_state($d['session_id']));
}

function h_display_heartbeat(): array
{
    $d = display_device();
    $applied = (int) (body()['appliedVersion'] ?? -1);
    q('UPDATE auction_devices SET last_heartbeat_at = ?, last_acked_version = CASE WHEN last_acked_version < ? THEN ? ELSE last_acked_version END WHERE id = ?',
        [iso(), $applied, $applied, $d['id']]);
    $v = (int) one('SELECT state_version FROM auction_states WHERE session_id = ?', [$d['session_id']])['state_version'];
    return ['serverVersion' => $v];
}

function h_display_ack(): array
{
    $d = display_device();
    $v = (int) (body()['version'] ?? -1);
    $now = iso();
    q('UPDATE auction_devices SET last_heartbeat_at = ?, last_acked_at = CASE WHEN last_acked_version < ? THEN ? ELSE last_acked_at END,
        last_acked_version = CASE WHEN last_acked_version < ? THEN ? ELSE last_acked_version END WHERE id = ?',
        [$now, $v, $now, $v, $v, $d['id']]);
    return ['ok' => true];
}

// ───────────────────────── images ─────────────────────────
function h_image_upload(): array
{
    require_admin();
    $dataUrl = (string) (body()['dataUrl'] ?? '');
    if (!preg_match('#^data:(image/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$#', $dataUrl, $m))
        throw new ApiError('VALIDATION_FAILED', 'Upload a JPEG, PNG or WebP image', 422);
    $bin = base64_decode($m[3], true);
    if ($bin === false || strlen($bin) > 3_000_000) throw new ApiError('VALIDATION_FAILED', 'Image is too large (max 3 MB)', 422);
    $info = @getimagesizefromstring($bin);
    if (!$info) throw new ApiError('VALIDATION_FAILED', 'File is not a valid image', 422);
    $id = bin2hex(random_bytes(16));
    $st = db()->prepare('INSERT INTO auction_images (id, mime, data, created_at) VALUES (?, ?, ?, ?)');
    $st->bindValue(1, $id);
    $st->bindValue(2, $m[1]);
    $st->bindValue(3, $bin, PDO::PARAM_LOB);
    $st->bindValue(4, iso());
    $st->execute();
    return ['ref' => '/api/index.php?r=/images/' . $id];
}

function h_image_get(string $id): never
{
    if (!preg_match('/^[0-9a-f]{32}$/', $id)) throw new ApiError('NOT_FOUND', 'Image not found', 404);
    $r = one('SELECT mime, data FROM auction_images WHERE id = ?', [$id]);
    if (!$r) throw new ApiError('NOT_FOUND', 'Image not found', 404);
    $data = is_resource($r['data']) ? stream_get_contents($r['data']) : $r['data'];
    header('Content-Type: ' . $r['mime']);
    header('Cache-Control: public, max-age=31536000, immutable');
    header('X-Content-Type-Options: nosniff');
    echo $data;
    exit;
}
