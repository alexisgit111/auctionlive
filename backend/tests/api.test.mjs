/**
 * API integration tests — run against a live PHP server with an EMPTY database:
 *   BASE=http://localhost:8080 SETUP_KEY=... node --test backend/tests/api.test.mjs
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { before, describe, it } from 'node:test'

const BASE = process.env.BASE ?? 'http://localhost:8080'
const SETUP_KEY = process.env.SETUP_KEY ?? 'test-setup-key'

function client() {
  let cookie = ''
  return async function call(method, route, body, headers = {}) {
    const res = await fetch(`${BASE}/api/index.php?r=${encodeURIComponent(route)}`, {
      method,
      headers: {
        'X-Requested-With': 'auction-live',
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const set = res.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]
    const json = await res.json()
    return { status: res.status, json }
  }
}

const admin = client()
const op1 = client()
const op2 = client()
const anon = client()
let sid
let lease

const K = (k) => String(k * 1000 * 100)

before(async () => {
  const st = await anon('GET', '/setup/status')
  if (st.json.needsAdmin) {
    const r = await anon('POST', '/setup/admin', { setupKey: SETUP_KEY, name: 'Test Admin', email: 'admin@test.local', password: 'Admin-pass-1' })
    assert.equal(r.status, 200, JSON.stringify(r.json))
  }
  assert.equal((await admin('POST', '/auth/login', { email: 'admin@test.local', password: 'Admin-pass-1' })).status, 200)
  for (const [c, n] of [
    [op1, 1],
    [op2, 2],
  ]) {
    const email = `op${n}-${Date.now()}@test.local`
    const r = await admin('POST', '/users', { name: `Operator ${n}`, email, role: 'operator', password: 'Operator-pass' })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal((await c('POST', '/auth/login', { email, password: 'Operator-pass' })).status, 200)
  }
  const s = await admin('POST', '/sessions', {
    title: 'API test',
    scheduledAt: new Date().toISOString(),
    auctioneerName: 'Secret Auctioneer',
    defaultIncrementCents: K(10),
    reserveCents: K(1300),
    internalNotes: 'VENDOR NOTE',
    property: { addressLine: '1 Test Road', suburb: 'Flat Bush', city: 'Auckland', heroImage: null, bedrooms: 4, bathrooms: 2, parking: 2, landAreaM2: 600, floorAreaM2: null, badge: '' },
    salespeople: [{ name: 'Jane Smith', photo: null }],
  })
  assert.equal(s.status, 200, JSON.stringify(s.json))
  sid = s.json.id
  lease = (await op1('POST', `/sessions/${sid}/lease`, {})).json.leaseToken
  assert.ok(lease)
})

async function exec(c, cmd, opts = {}) {
  const v = (await c('GET', `/sessions/${sid}/view`)).json.state.stateVersion
  return c('POST', `/sessions/${sid}/execute`, {
    cmd,
    idempotencyKey: opts.key ?? randomUUID(),
    expectedVersion: opts.version ?? v,
    leaseToken: opts.lease ?? lease,
  })
}

describe('security', () => {
  it('rejects anonymous access and wrong passwords', async () => {
    assert.equal((await anon('GET', '/sessions')).status, 401)
    assert.equal((await anon('POST', '/auth/login', { email: 'admin@test.local', password: 'nope' })).status, 401)
  })
  it('rejects POSTs without the API header (CSRF guard)', async () => {
    const res = await fetch(`${BASE}/api/index.php?r=/auth/login`, { method: 'POST', body: '{}' })
    assert.equal(res.status, 403)
  })
  it('operators cannot create sessions or users', async () => {
    assert.equal((await op1('POST', '/sessions', {})).status, 403)
    assert.equal((await op1('POST', '/users', {})).status, 403)
  })
})

describe('bidding', () => {
  it('starts and accepts bids; rejects lower bids', async () => {
    assert.equal((await exec(op1, { type: 'START' })).status, 200)
    const r = await exec(op1, { type: 'BID', amountCents: K(950) })
    assert.equal(r.status, 200)
    assert.equal(r.json.state.currentBidCents, K(950))
    const low = await exec(op1, { type: 'BID', amountCents: K(900) })
    assert.equal(low.status, 409)
    assert.equal(low.json.error.code, 'BID_NOT_HIGHER')
  })

  it('same idempotency key twice (in parallel) records exactly one bid', async () => {
    const v = (await op1('GET', `/sessions/${sid}/view`)).json.state.stateVersion
    const key = randomUUID()
    const body = { cmd: { type: 'BID', amountCents: K(1000) }, idempotencyKey: key, expectedVersion: v, leaseToken: lease }
    const [a, b] = await Promise.all([op1('POST', `/sessions/${sid}/execute`, body), op1('POST', `/sessions/${sid}/execute`, body)])
    assert.equal(a.status, 200)
    assert.equal(b.status, 200)
    assert.equal(a.json.bid.id, b.json.bid.id)
    const bids = (await op1('GET', `/sessions/${sid}/bids`)).json.filter((x) => x.amountCents === K(1000))
    assert.equal(bids.length, 1)
    const st = await op1('GET', `/idempotency/${key}`)
    assert.equal(st.json.status, 'COMPLETED')
  })

  it('stale expectedVersion is rejected', async () => {
    const r = await exec(op1, { type: 'BID', amountCents: K(1100) }, { version: 1 })
    assert.equal(r.status, 409)
    assert.equal(r.json.error.code, 'VERSION_CONFLICT')
  })

  it('second operator is locked out, admin takeover is audited', async () => {
    assert.equal((await op2('POST', `/sessions/${sid}/lease`, {})).status, 423)
    assert.equal((await exec(op2, { type: 'BID', amountCents: K(1200) }, { lease: 'forged' })).status, 423)
    assert.equal((await admin('POST', `/sessions/${sid}/lease/takeover`, { reason: '' })).status, 422)
    const t = await admin('POST', `/sessions/${sid}/lease/takeover`, { reason: 'Laptop froze' })
    assert.equal(t.status, 200)
    assert.equal((await exec(op1, { type: 'BID', amountCents: K(1200) })).status, 423) // op1 lost control
    lease = t.json.leaseToken
    const r = await exec(admin, { type: 'BID', amountCents: K(1200) })
    assert.equal(r.status, 200)
    const events = (await admin('GET', `/sessions/${sid}/events`)).json
    const takeover = events.find((e) => e.type === 'OPERATOR_TAKEOVER')
    assert.equal(takeover.reason, 'Laptop froze')
    const seqs = events.map((e) => e.seq)
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b))
  })

  it('undo requires a reason and keeps the record', async () => {
    const v = (await admin('GET', `/sessions/${sid}/view`)).json
    assert.equal((await exec(admin, { type: 'UNDO', bidId: v.state.currentBidId, reason: ' ' })).status, 422)
    const r = await exec(admin, { type: 'UNDO', bidId: v.state.currentBidId, reason: 'Misheard' })
    assert.equal(r.status, 200)
    assert.equal(r.json.state.currentBidCents, K(1000))
    const bids = (await admin('GET', `/sessions/${sid}/bids`)).json
    assert.equal(bids.find((b) => b.amountCents === K(1200)).status, 'REVERSED')
  })
})

describe('room display', () => {
  it('pairs once, sees only public data, honours revocation', async () => {
    const req = (await anon('POST', '/display/pairing', {})).json
    assert.match(req.code, /^[A-Z0-9]{6}$/)
    assert.equal((await anon('GET', `/display/pairing/${req.pairingId}`)).json.status, 'PENDING')
    const dev = await admin('POST', '/pairing/approve', { code: req.code.toLowerCase(), sessionId: sid, label: 'Room A' })
    assert.equal(dev.status, 200, JSON.stringify(dev.json))
    const claim = (await anon('GET', `/display/pairing/${req.pairingId}`)).json
    assert.equal(claim.status, 'APPROVED')
    assert.equal((await anon('GET', `/display/pairing/${req.pairingId}`)).json.token, undefined)

    const disp = client()
    const H = { 'X-Display-Token': claim.token }
    const pub = await disp('GET', '/display/state', undefined, H)
    assert.equal(pub.status, 200)
    const text = JSON.stringify(pub.json)
    for (const secret of ['130000000', 'VENDOR NOTE', 'Secret Auctioneer', 'reserve', 'internalNotes', 'operatorId'])
      assert.ok(!text.includes(secret), `public payload leaked ${secret}`)
    assert.deepEqual(pub.json.salespeople, [{ name: 'Jane Smith', photo: null }])

    const hb = await disp('POST', '/display/heartbeat', { appliedVersion: pub.json.stateVersion }, H)
    assert.equal(hb.json.serverVersion, pub.json.stateVersion)
    const view = (await admin('GET', `/sessions/${sid}/view`)).json
    assert.equal(view.devices[0].lastAckedVersion, pub.json.stateVersion)

    // display token cannot call staff routes
    assert.equal((await disp('GET', '/sessions', undefined, H)).status, 401)

    await admin('POST', `/devices/${dev.json.id}/revoke`, {})
    assert.equal((await disp('GET', '/display/state', undefined, H)).status, 401)
  })
})

describe('images', () => {
  it('uploads and serves an image', async () => {
    const png1x1 =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const up = await admin('POST', '/images', { dataUrl: png1x1 })
    assert.equal(up.status, 200, JSON.stringify(up.json))
    const res = await fetch(BASE + up.json.ref)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/png')
    assert.equal((await op1('POST', '/images', { dataUrl: png1x1 })).status, 403)
  })
})
