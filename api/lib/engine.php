<?php
/**
 * Auction state machine — a 1:1 port of frontend/src/engine/engine.ts.
 * Pure: no I/O. Works on plain arrays with the same camelCase shapes as the TS types.
 * Money is integer cents (PHP int is 64-bit), serialised as digit strings.
 */
defined('AUCTION_API') or exit;

function eng_initial_state(string $sessionId, string $now): array
{
    return [
        'sessionId' => $sessionId,
        'sessionStatus' => 'NOT_STARTED',
        'saleStatus' => 'NONE',
        'currentBidId' => null,
        'currentBidCents' => null,
        'bidCount' => 0,
        'stateVersion' => 0,
        'eventSeq' => 0,
        'updatedAt' => $now,
        'overlayHidden' => false,
        'welcomeOn' => false,
        'musicOn' => false,
        'volume' => 80,
    ];
}

function eng_snapshot(array $s): array
{
    return [
        'sessionStatus' => $s['sessionStatus'],
        'saleStatus' => $s['saleStatus'],
        'currentBidId' => $s['currentBidId'],
        'currentBidCents' => $s['currentBidCents'],
        'bidCount' => $s['bidCount'],
        'stateVersion' => $s['stateVersion'],
    ];
}

function eng_transition(string $msg): ApiError
{
    return new ApiError('INVALID_TRANSITION', $msg, 409);
}

function eng_sale_open(array $s): bool
{
    return $s['saleStatus'] === 'NONE' || $s['saleStatus'] === 'ON_THE_MARKET';
}

function eng_active_bids(array $bids): array
{
    $a = array_values(array_filter($bids, fn($b) => $b['status'] === 'ACTIVE'));
    usort($a, fn($x, $y) => $x['seq'] <=> $y['seq']);
    return $a;
}

function eng_recompute(array $s, array $bids): array
{
    $active = eng_active_bids($bids);
    $top = $active ? $active[count($active) - 1] : null;
    $s['currentBidId'] = $top['id'] ?? null;
    $s['currentBidCents'] = $top['amountCents'] ?? null;
    $s['bidCount'] = count($active);
    return $s;
}

function eng_amount(string $cents): int
{
    if (!preg_match('/^[1-9][0-9]{0,13}$/', $cents)) throw new ApiError('INVALID_AMOUNT', 'Invalid amount', 400);
    $v = (int) $cents;
    if ($v % 100 !== 0) throw new ApiError('INVALID_AMOUNT', 'Bids must be whole dollars', 400);
    if ($v > 100_000_000_00) throw new ApiError('INVALID_AMOUNT', 'Amount exceeds the $100,000,000 safety limit', 400);
    return $v;
}

/**
 * @param array $state current state
 * @param array $bids  all bids of the session (any status)
 * @param array $cmd   command
 * @param array $ctx   ['operatorId', 'now', 'idempotencyKey']
 * @return array ['state', 'bids', 'event', 'bid' => new bid|null, 'changedBidIds' => string[]]
 */
function eng_apply(array $state, array $bids, array $cmd, array $ctx): array
{
    $prev = $state;
    $next = $state;
    $reason = null;
    $data = null;
    $newBid = null;
    $changed = [];
    $type = $cmd['type'] ?? '';
    $running = $state['sessionStatus'] === 'LIVE' || $state['sessionStatus'] === 'PAUSED';
    $maxSeq = array_reduce($bids, fn($m, $b) => max($m, (int) $b['seq']), 0);

    switch ($type) {
        case 'START':
            if ($state['sessionStatus'] !== 'NOT_STARTED') throw eng_transition('Auction has already started');
            $next['sessionStatus'] = 'LIVE';
            $evType = 'AUCTION_STARTED';
            break;

        case 'PAUSE':
            if ($state['sessionStatus'] !== 'LIVE') throw eng_transition('Only a live auction can be paused');
            if (!eng_sale_open($state)) throw eng_transition('Sale is already concluded');
            $next['sessionStatus'] = 'PAUSED';
            $evType = 'PAUSED';
            break;

        case 'RESUME':
            if ($state['sessionStatus'] !== 'PAUSED') throw eng_transition('Auction is not paused');
            $next['sessionStatus'] = 'LIVE';
            $evType = 'RESUMED';
            break;

        case 'ON_THE_MARKET':
            if ($state['sessionStatus'] !== 'LIVE') throw eng_transition('Auction must be live');
            if ($state['saleStatus'] !== 'NONE') throw eng_transition('Property is already on the market or concluded');
            $next['saleStatus'] = 'ON_THE_MARKET';
            $evType = 'ON_THE_MARKET';
            break;

        case 'OFF_MARKET':
            if (!$running) throw eng_transition('Auction is not running');
            if ($state['saleStatus'] !== 'ON_THE_MARKET') throw eng_transition('Property is not on the market');
            $next['saleStatus'] = 'NONE';
            $evType = 'OFF_THE_MARKET';
            break;

        case 'SET_OVERLAY':
            if ($state['sessionStatus'] === 'NOT_STARTED') throw eng_transition('Auction has not started');
            $hide = !empty($cmd['hidden']);
            if (!empty($state['overlayHidden']) === $hide)
                throw eng_transition($hide ? 'Stickers are already hidden' : 'Stickers are already shown');
            $next['overlayHidden'] = $hide;
            if ($hide) $next['call'] = 0; // "Remove" clears every sticker, calls included
            $evType = $hide ? 'OVERLAY_HIDDEN' : 'OVERLAY_SHOWN';
            break;

        case 'FIRST_CALL':
        case 'SECOND_CALL':
            if ($state['sessionStatus'] !== 'LIVE') throw eng_transition('Calls can only be made while the auction is live');
            if (!eng_sale_open($state)) throw eng_transition('Sale is already concluded');
            $next['call'] = $type === 'FIRST_CALL' ? 1 : 2;
            $next['overlayHidden'] = false;
            $evType = $type;
            break;

        case 'WITHDRAWN_SOLD':
            if (!$running) throw eng_transition('Auction is not running');
            if (!eng_sale_open($state)) throw eng_transition('Sale is already concluded');
            $next['concludedFrom'] = ['sessionStatus' => $state['sessionStatus'], 'saleStatus' => $state['saleStatus']];
            $next['saleStatus'] = 'SOLD';
            $next['sessionStatus'] = 'ENDED';
            $next['withdrawnSold'] = true;
            $evType = 'WITHDRAWN_SOLD';
            $data = ['soldCents' => $state['currentBidCents']];
            break;

        case 'SOLD':
            if (!$running) throw eng_transition('Auction is not running');
            if (!eng_sale_open($state)) throw eng_transition('Sale is already concluded');
            if ($state['bidCount'] === 0 || !$state['currentBidCents']) throw eng_transition('Cannot mark sold without an accepted bid');
            $next['concludedFrom'] = ['sessionStatus' => $state['sessionStatus'], 'saleStatus' => $state['saleStatus']];
            $next['saleStatus'] = 'SOLD';
            $next['sessionStatus'] = 'ENDED';
            $evType = 'SOLD';
            $data = ['soldCents' => $state['currentBidCents'], 'soldBidId' => $state['currentBidId']];
            break;

        case 'PASSED_IN':
            if (!$running) throw eng_transition('Auction is not running');
            if (!eng_sale_open($state)) throw eng_transition('Sale is already concluded');
            $next['concludedFrom'] = ['sessionStatus' => $state['sessionStatus'], 'saleStatus' => $state['saleStatus']];
            $next['saleStatus'] = 'PASSED_IN';
            $next['sessionStatus'] = 'ENDED';
            $evType = 'PASSED_IN';
            $data = ['highestCents' => $state['currentBidCents']];
            break;

        case 'END':
            if (!$running) throw eng_transition('Auction is not running');
            $next['concludedFrom'] = ['sessionStatus' => $state['sessionStatus'], 'saleStatus' => $state['saleStatus']];
            $next['sessionStatus'] = 'ENDED';
            $evType = 'AUCTION_ENDED';
            break;

        case 'HIDE_PRICE':
            if (!empty($state['priceHidden'])) throw eng_transition('The price is already hidden');
            $next['priceHidden'] = true;
            $evType = 'PRICE_HIDDEN';
            break;

        case 'SHOW_PRICE':
            if (empty($state['priceHidden'])) throw eng_transition('The price is already shown');
            $next['priceHidden'] = false;
            $evType = 'PRICE_SHOWN';
            break;

        case 'SET_WELCOME':
            $on = !empty($cmd['on']);
            if (!empty($state['welcomeOn']) === $on) throw eng_transition($on ? 'Welcome screen is already on' : 'Welcome screen is already off');
            $next['welcomeOn'] = $on;
            $evType = $on ? 'WELCOME_SHOWN' : 'WELCOME_HIDDEN';
            break;

        case 'SET_MUSIC':
            $on = !empty($cmd['on']);
            if (!empty($state['musicOn']) === $on) throw eng_transition($on ? 'Music is already playing' : 'Music is already off');
            $next['musicOn'] = $on;
            $evType = $on ? 'MUSIC_STARTED' : 'MUSIC_STOPPED';
            break;

        case 'SET_VOLUME':
            $raw = $cmd['percent'] ?? null;
            if (!is_numeric($raw)) throw new ApiError('VALIDATION_FAILED', 'Volume must be 0–100', 422);
            $v = (int) round((float) $raw);
            if ($v < 0 || $v > 100) throw new ApiError('VALIDATION_FAILED', 'Volume must be 0–100', 422);
            if ($v === (int) ($state['volume'] ?? 80)) throw eng_transition('Volume unchanged');
            $next['volume'] = $v;
            $evType = 'VOLUME_SET';
            $data = ['volume' => $v];
            break;

        case 'REOPEN':
            // Undo Sold / Passed in / End: back to exactly where the auction was. Bids are untouched.
            if ($state['sessionStatus'] !== 'ENDED') throw eng_transition('Auction has not ended');
            $reason = trim((string) ($cmd['reason'] ?? '')) ?: 'Reopened';
            $back = $state['concludedFrom'] ?? ['sessionStatus' => 'PAUSED', 'saleStatus' => 'NONE'];
            $next['sessionStatus'] = in_array($back['sessionStatus'] ?? '', ['LIVE', 'PAUSED'], true) ? $back['sessionStatus'] : 'PAUSED';
            $next['saleStatus'] = ($back['saleStatus'] ?? '') === 'ON_THE_MARKET' ? 'ON_THE_MARKET' : 'NONE';
            $next['concludedFrom'] = null;
            $next['withdrawnSold'] = false;
            $evType = 'REOPENED';
            $data = ['fromSaleStatus' => $state['saleStatus']];
            break;

        case 'BID':
            if ($state['sessionStatus'] !== 'LIVE') throw eng_transition('Bids can only be entered while the auction is live');
            if (!eng_sale_open($state)) throw eng_transition('Sale is already concluded');
            $amount = eng_amount((string) ($cmd['amountCents'] ?? ''));
            if ($state['currentBidCents'] !== null && $amount <= (int) $state['currentBidCents'])
                throw new ApiError('BID_NOT_HIGHER', 'Bid must be higher than the current bid', 409, ['currentBidCents' => $state['currentBidCents']]);
            $newBid = [
                'id' => ulid(),
                'sessionId' => $state['sessionId'],
                'seq' => $maxSeq + 1,
                'amountCents' => (string) $amount,
                'status' => 'ACTIVE',
                'supersedesBidId' => null,
                'operatorId' => $ctx['operatorId'],
                'idempotencyKey' => $ctx['idempotencyKey'],
                'source' => 'CLOUD',
                'createdAt' => $ctx['now'],
            ];
            $bids[] = $newBid;
            $next = eng_recompute($next, $bids);
            $evType = 'BID_ACCEPTED';
            $data = ['bidId' => $newBid['id'], 'bidSeq' => $newBid['seq'], 'amountCents' => $newBid['amountCents']];
            break;

        case 'UNDO':
            if (!$running) throw eng_transition('Auction is not running');
            if (!eng_sale_open($state)) throw eng_transition('Sale is already concluded');
            $reason = trim((string) ($cmd['reason'] ?? '')) ?: 'Undone';
            if (($cmd['bidId'] ?? null) !== $state['currentBidId']) throw eng_transition('Only the latest accepted bid can be undone');
            foreach ($bids as &$b) if ($b['id'] === $cmd['bidId']) $b['status'] = 'REVERSED';
            unset($b);
            $changed[] = $cmd['bidId'];
            $next = eng_recompute($next, $bids);
            $evType = 'BID_UNDONE';
            $data = ['bidId' => $cmd['bidId'], 'amountCents' => $state['currentBidCents']];
            break;

        case 'CORRECT':
            if (!$running) throw eng_transition('Auction is not running');
            if (!eng_sale_open($state)) throw eng_transition('Sale is already concluded');
            $reason = trim((string) ($cmd['reason'] ?? '')) ?: 'Corrected';
            if (($cmd['bidId'] ?? null) !== $state['currentBidId']) throw eng_transition('Only the latest accepted bid can be corrected');
            $amount = eng_amount((string) ($cmd['amountCents'] ?? ''));
            if ((string) $amount === $state['currentBidCents'])
                throw new ApiError('VALIDATION_FAILED', 'Corrected amount is the same as the original', 422);
            // Any amount is allowed (higher or lower) — the original stays in the record as CORRECTED.
            $original = null;
            foreach ($bids as &$b) {
                if ($b['id'] === $cmd['bidId']) {
                    $original = $b;
                    $b['status'] = 'CORRECTED';
                }
            }
            unset($b);
            $changed[] = $cmd['bidId'];
            $newBid = [
                'id' => ulid(),
                'sessionId' => $state['sessionId'],
                'seq' => $maxSeq + 1,
                'amountCents' => (string) $amount,
                'status' => 'ACTIVE',
                'supersedesBidId' => $original['id'],
                'operatorId' => $ctx['operatorId'],
                'idempotencyKey' => $ctx['idempotencyKey'],
                'source' => 'CLOUD',
                'createdAt' => $ctx['now'],
            ];
            $bids[] = $newBid;
            $next = eng_recompute($next, $bids);
            $evType = 'BID_CORRECTED';
            $data = ['originalBidId' => $original['id'], 'fromCents' => $original['amountCents'], 'toCents' => $newBid['amountCents'], 'bidId' => $newBid['id']];
            break;

        default:
            throw new ApiError('VALIDATION_FAILED', 'Unknown command', 422);
    }

    // Any new status brings the stickers back so the room sees it.
    $statusChanged = $next['sessionStatus'] !== $state['sessionStatus'] || $next['saleStatus'] !== $state['saleStatus'];
    if (!in_array($type, ['SET_OVERLAY', 'FIRST_CALL', 'SECOND_CALL'], true)) {
        $next['overlayHidden'] = $statusChanged ? false : !empty($state['overlayHidden']);
    }
    // A call stands until the next bid / correction / undo or any status change.
    if ($statusChanged || in_array($type, ['BID', 'CORRECT', 'UNDO'], true)) $next['call'] = 0;
    // Room media follows the auction (see engine.ts)
    if ($type === 'START') $next['welcomeOn'] = false;
    // A new / corrected / undone price is always shown again.
    if (in_array($type, ['BID', 'CORRECT', 'UNDO'], true)) $next['priceHidden'] = false;
    if ($type !== 'SET_MUSIC') {
        if ($next['sessionStatus'] === 'PAUSED' && $state['sessionStatus'] !== 'PAUSED') $next['musicOn'] = true;
        elseif ($state['sessionStatus'] === 'PAUSED' && $next['sessionStatus'] !== 'PAUSED') $next['musicOn'] = false;
        elseif ($next['sessionStatus'] === 'ENDED' && $state['sessionStatus'] !== 'ENDED') $next['musicOn'] = false;
    }
    $next['stateVersion'] = $state['stateVersion'] + 1;
    $next['eventSeq'] = $state['eventSeq'] + 1;
    $next['updatedAt'] = $ctx['now'];

    $event = [
        'sessionId' => $state['sessionId'],
        'seq' => $next['eventSeq'],
        'type' => $evType,
        'previousState' => eng_snapshot($prev),
        'newState' => eng_snapshot($next),
        'operatorId' => $ctx['operatorId'],
        'serverTimestamp' => $ctx['now'],
        'stateVersion' => $next['stateVersion'],
        'reason' => $reason,
        'idempotencyKey' => $ctx['idempotencyKey'],
        'data' => $data,
    ];
    return ['state' => $next, 'bids' => $bids, 'event' => $event, 'bid' => $newBid, 'changedBidIds' => $changed];
}

// ───────────────────────── public display serializer (explicit whitelist) ─────────────────────────
function format_cents(?string $cents): string
{
    if ($cents === null || $cents === '') return '';
    $c = (int) $cents;
    $dollars = intdiv($c, 100);
    $rem = $c % 100;
    return '$' . number_format($dollars) . ($rem ? sprintf('.%02d', $rem) : '');
}

function derive_public_status(array $s): string
{
    if ($s['saleStatus'] === 'SOLD') return 'SOLD';
    if ($s['saleStatus'] === 'PASSED_IN') return 'PASSED_IN';
    return match ($s['sessionStatus']) {
        'NOT_STARTED' => 'NOT_STARTED',
        'PAUSED' => 'PAUSED',
        'ENDED' => 'ENDED',
        default => $s['saleStatus'] === 'ON_THE_MARKET' ? 'ON_THE_MARKET' : 'LIVE',
    };
}

function to_public_state(array $session, array $state): array
{
    // No price on the room screen before the auction starts, or after "0 SET".
    $noPrice = $state['sessionStatus'] === 'NOT_STARTED' || !empty($state['priceHidden']);
    $p = $session['property'] ?? [];
    $num = fn($v) => is_numeric($v) ? (int) $v : null;
    $people = [];
    foreach (array_slice(array_values(array_filter($session['salespeople'] ?? [], fn($x) => trim((string) ($x['name'] ?? '')) !== '')), 0, 2) as $x) {
        $people[] = ['name' => trim((string) $x['name']), 'photo' => $x['photo'] ?? null];
    }
    return [
        'sessionId' => $state['sessionId'],
        'stateVersion' => $state['stateVersion'],
        'sessionStatus' => $state['sessionStatus'],
        'saleStatus' => $state['saleStatus'],
        'publicStatus' => derive_public_status($state),
        'overlayHidden' => !empty($state['overlayHidden']),
        'call' => in_array((int) ($state['call'] ?? 0), [1, 2], true) ? (int) $state['call'] : 0,
        'welcomeOn' => !empty($state['welcomeOn']),
        'musicOn' => !empty($state['musicOn']),
        'volume' => (int) ($state['volume'] ?? 80),
        'media' => room_media_public(),
        'priceHidden' => $noPrice,
        'currentBidCents' => $noPrice ? null : $state['currentBidCents'],
        'currentBidDisplay' => $noPrice ? '' : format_cents($state['currentBidCents']),
        'property' => [
            'addressLine' => (string) ($p['addressLine'] ?? ''),
            'suburb' => (string) ($p['suburb'] ?? ''),
            'city' => (string) ($p['city'] ?? ''),
            'heroImage' => $p['heroImage'] ?? null,
            'bedrooms' => $num($p['bedrooms'] ?? null),
            'bathrooms' => $num($p['bathrooms'] ?? null),
            'parking' => $num($p['parking'] ?? null),
            'landAreaM2' => $num($p['landAreaM2'] ?? null),
            'floorAreaM2' => $num($p['floorAreaM2'] ?? null),
            'badge' => (string) ($p['badge'] ?? ''),
        ],
        'salespeople' => $people,
        'brand' => ['name' => 'Harcourts Golden Links'],
        'serverTime' => iso(),
    ];
}
