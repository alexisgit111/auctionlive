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

  it('second operator is locked out until they take over (one step, no reason); takeover is audited', async () => {
    assert.equal((await op2('POST', `/sessions/${sid}/lease`, {})).status, 423)
    assert.equal((await exec(op2, { type: 'BID', amountCents: K(1200) }, { lease: 'forged' })).status, 423)
    const t2 = await op2('POST', `/sessions/${sid}/lease/takeover`, {})
    assert.equal(t2.status, 200, JSON.stringify(t2.json))
    const auto = (await admin('GET', `/sessions/${sid}/events`)).json.filter((e) => e.type === 'OPERATOR_TAKEOVER').at(-1)
    assert.equal(auto.reason, 'Taken over')
    const t = await admin('POST', `/sessions/${sid}/lease/takeover`, { reason: 'Laptop froze' })
    assert.equal(t.status, 200)
    assert.equal((await exec(op1, { type: 'BID', amountCents: K(1200) })).status, 423) // op1 lost control
    lease = t.json.leaseToken
    const r = await exec(admin, { type: 'BID', amountCents: K(1200) })
    assert.equal(r.status, 200)
    const events = (await admin('GET', `/sessions/${sid}/events`)).json
    const takeover = events.filter((e) => e.type === 'OPERATOR_TAKEOVER').at(-1)
    assert.equal(takeover.reason, 'Laptop froze')
    const seqs = events.map((e) => e.seq)
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b))
  })

  it('undo needs no reason (a default is recorded) and keeps the record', async () => {
    const v = (await admin('GET', `/sessions/${sid}/view`)).json
    const r = await exec(admin, { type: 'UNDO', bidId: v.state.currentBidId })
    assert.equal(r.status, 200)
    assert.equal(r.json.state.currentBidCents, K(1000))
    const bids = (await admin('GET', `/sessions/${sid}/bids`)).json
    assert.equal(bids.find((b) => b.amountCents === K(1200)).status, 'REVERSED')
    const ev = (await admin('GET', `/sessions/${sid}/events`)).json.filter((e) => e.type === 'BID_UNDONE').at(-1)
    assert.equal(ev.reason, 'Undone')
  })

  it('on the market can be undone; stickers can be hidden and come back on a new status', async () => {
    assert.equal((await exec(admin, { type: 'ON_THE_MARKET' })).json.state.saleStatus, 'ON_THE_MARKET')
    const off = await exec(admin, { type: 'OFF_MARKET' })
    assert.equal(off.status, 200, JSON.stringify(off.json))
    assert.equal(off.json.state.saleStatus, 'NONE')
    assert.equal((await exec(admin, { type: 'OFF_MARKET' })).status, 409)
    const hide = await exec(admin, { type: 'SET_OVERLAY', hidden: true })
    assert.equal(hide.status, 200)
    assert.equal(hide.json.state.overlayHidden, true)
    assert.equal((await exec(admin, { type: 'SET_OVERLAY', hidden: true })).status, 409)
    const otm = await exec(admin, { type: 'ON_THE_MARKET' })
    assert.equal(otm.json.state.overlayHidden, false)
    const types = (await admin('GET', `/sessions/${sid}/events`)).json.map((e) => e.type)
    for (const t of ['OFF_THE_MARKET', 'OVERLAY_HIDDEN']) assert.ok(types.includes(t), t)
  })

  it('a bid can be corrected to any amount; SOLD can be undone (reopen)', async () => {
    let v = (await admin('GET', `/sessions/${sid}/view`)).json.state
    const low = await exec(admin, { type: 'CORRECT', bidId: v.currentBidId, amountCents: K(905), reason: 'Misheard' })
    assert.equal(low.status, 200, JSON.stringify(low.json))
    assert.equal(low.json.state.currentBidCents, K(905))
    assert.equal((await exec(admin, { type: 'BID', amountCents: K(905) })).status, 409)
    assert.equal((await exec(admin, { type: 'BID', amountCents: K(910) })).status, 200)

    assert.equal((await exec(admin, { type: 'SOLD' })).json.state.saleStatus, 'SOLD')
    const re = await exec(admin, { type: 'REOPEN', reason: 'Pressed by mistake' })
    assert.equal(re.status, 200, JSON.stringify(re.json))
    assert.equal(re.json.state.sessionStatus, 'LIVE')
    assert.equal(re.json.state.saleStatus, 'ON_THE_MARKET')
    assert.equal(re.json.state.currentBidCents, K(910))
    assert.equal((await exec(admin, { type: 'REOPEN', reason: 'again' })).status, 409)
    const ev = (await admin('GET', `/sessions/${sid}/events`)).json.find((e) => e.type === 'REOPENED')
    assert.equal(ev.reason, 'Pressed by mistake')

    // 0 SET: the price disappears from the room screen until the next bid
    const hid = await exec(admin, { type: 'HIDE_PRICE' })
    assert.equal(hid.status, 200, JSON.stringify(hid.json))
    assert.equal(hid.json.state.priceHidden, true)
    assert.equal(hid.json.state.currentBidCents, K(910)) // the record keeps it
    const shown = await exec(admin, { type: 'BID', amountCents: K(920) })
    assert.equal(shown.json.state.priceHidden, false)
    // SOLD then REOPEN without a reason → default reason
    await exec(admin, { type: 'SOLD' })
    const re2 = await exec(admin, { type: 'REOPEN' })
    assert.equal(re2.status, 200, JSON.stringify(re2.json))
  })
})

describe('calls and withdrawn & sold', () => {
  it('1st/2nd call stickers clear on the next bid; Remove clears them; Withdrawn & Sold → SOLD, reopenable', async () => {
    const c1 = await exec(admin, { type: 'FIRST_CALL' })
    assert.equal(c1.status, 200, JSON.stringify(c1.json))
    assert.equal(c1.json.state.call, 1)
    assert.equal((await exec(admin, { type: 'SECOND_CALL' })).json.state.call, 2)
    const cur = BigInt(c1.json.state.currentBidCents)
    assert.equal((await exec(admin, { type: 'BID', amountCents: String(cur + 1_000_000n) })).json.state.call, 0)
    await exec(admin, { type: 'FIRST_CALL' })
    const rm = await exec(admin, { type: 'SET_OVERLAY', hidden: true })
    assert.equal(rm.json.state.call, 0)
    assert.equal(rm.json.state.overlayHidden, true)
    const w = await exec(admin, { type: 'WITHDRAWN_SOLD' })
    assert.equal(w.status, 200, JSON.stringify(w.json))
    assert.equal(w.json.state.saleStatus, 'SOLD')
    assert.equal(w.json.state.withdrawnSold, true)
    const back = await exec(admin, { type: 'REOPEN' })
    assert.equal(back.json.state.sessionStatus, 'LIVE')
    assert.equal(back.json.state.withdrawnSold, false)
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

    // long poll: answers immediately when behind, holds while up to date, wakes on a change
    const t0 = Date.now()
    const held = disp('POST', '/display/heartbeat', { appliedVersion: hb.json.serverVersion, wait: true, sessionId: sid }, H)
    await new Promise((r) => setTimeout(r, 500))
    await exec(admin, { type: 'SET_OVERLAY', hidden: true })
    const woke = await held
    assert.equal(woke.json.serverVersion, hb.json.serverVersion + 1)
    assert.ok(Date.now() - t0 < 2500, `long poll should wake on change (took ${Date.now() - t0} ms)`)
    const t1 = Date.now()
    const idle = await disp('POST', '/display/heartbeat', { appliedVersion: woke.json.serverVersion, wait: true, sessionId: sid }, H)
    assert.equal(idle.status, 200)
    assert.ok(Date.now() - t1 >= 1000, 'idle long poll should be held')

    // move the screen to another session — no re-pairing, audited on both
    const s2 = await admin('POST', '/sessions', { title: 'Second', scheduledAt: new Date().toISOString(), salespeople: [], defaultIncrementCents: K(10), property: { addressLine: '2 Next Street', suburb: 'Glen Eden', city: 'Auckland', heroImage: null } })
    assert.equal(s2.status, 200, JSON.stringify(s2.json))
    const list = (await op1('GET', '/devices')).json
    assert.ok(list.some((d) => d.id === dev.json.id && d.sessionAddress === '1 Test Road' && !('tokenHash' in d)))
    assert.equal((await anon('POST', `/devices/${dev.json.id}/move`, { sessionId: s2.json.id })).status, 401)
    const mv = await op1('POST', `/devices/${dev.json.id}/move`, { sessionId: s2.json.id })
    assert.equal(mv.status, 200, JSON.stringify(mv.json))
    const moved = await disp('POST', '/display/heartbeat', { appliedVersion: woke.json.serverVersion, wait: true, sessionId: sid }, H)
    assert.equal(moved.json.sessionId, s2.json.id)
    assert.equal((await disp('GET', '/display/state', undefined, H)).json.property.addressLine, '2 Next Street')
    const t2 = (await admin('GET', `/sessions/${s2.json.id}/events`)).json.map((e) => e.type)
    assert.ok(t2.includes('DISPLAY_MOVED_IN'))
    assert.ok((await admin('GET', `/sessions/${sid}/events`)).json.some((e) => e.type === 'DISPLAY_MOVED_OUT'))

    await admin('POST', `/devices/${dev.json.id}/revoke`, {})
    assert.equal((await disp('GET', '/display/state', undefined, H)).status, 401)
    assert.equal((await op1('POST', `/devices/${dev.json.id}/move`, { sessionId: sid })).status, 404)
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

describe('room media', () => {
  it('welcome / music / volume commands, with music following pause', async () => {
    const s3 = await admin('POST', '/sessions', { title: 'Media', scheduledAt: new Date().toISOString(), salespeople: [], defaultIncrementCents: K(10), property: { addressLine: '3 Media Lane', suburb: 'Mt Roskill', city: 'Auckland', heroImage: null } })
    const id = s3.json.id
    const lease3 = (await admin('POST', `/sessions/${id}/lease`, {})).json.leaseToken
    const run = async (cmd) => {
      const v = (await admin('GET', `/sessions/${id}/view`)).json.state.stateVersion
      return admin('POST', `/sessions/${id}/execute`, { cmd, idempotencyKey: randomUUID(), expectedVersion: v, leaseToken: lease3 })
    }
    assert.equal((await run({ type: 'SET_WELCOME', on: true })).json.state.welcomeOn, true)
    const started = await run({ type: 'START' })
    assert.equal(started.json.state.welcomeOn, false)
    assert.equal((await run({ type: 'PAUSE' })).json.state.musicOn, true)
    assert.equal((await run({ type: 'SET_MUSIC', on: false })).json.state.musicOn, false)
    assert.equal((await run({ type: 'SET_MUSIC', on: false })).status, 409)
    assert.equal((await run({ type: 'SET_MUSIC', on: true })).json.state.musicOn, true)
    assert.equal((await run({ type: 'RESUME' })).json.state.musicOn, false)
    assert.equal((await run({ type: 'SET_VOLUME', percent: 55 })).json.state.volume, 55)
    assert.equal((await run({ type: 'SET_VOLUME', percent: 150 })).status, 422)
    const types = (await admin('GET', `/sessions/${id}/events`)).json.map((e) => e.type)
    for (const t of ['WELCOME_SHOWN', 'MUSIC_STOPPED', 'MUSIC_STARTED', 'VOLUME_SET']) assert.ok(types.includes(t), t)
  })

  it('uploads music in chunks, streams with Range, publishes it to paired screens', async () => {
    // a fake 1.2 MB "MP3": ID3 header + bytes → 3 chunks of 512 KB
    const bytes = Buffer.alloc(1_200_000)
    bytes.write('ID3', 0)
    for (let i = 3; i < bytes.length; i++) bytes[i] = i % 251
    assert.equal((await op1('POST', '/media/upload/start', { name: 'x.mp3', size: bytes.length, mime: 'audio/mpeg' })).status, 403)
    assert.equal((await admin('POST', '/media/upload/start', { name: 'x.exe', size: 10, mime: 'application/octet-stream' })).status, 422)
    const st = (await admin('POST', '/media/upload/start', { name: 'Hello.mp3', size: bytes.length, mime: 'audio/mpeg' })).json
    const n = Math.ceil(bytes.length / st.chunkSize)
    assert.equal(n, 3)
    for (let i = 0; i < n; i++) {
      const data = bytes.subarray(i * st.chunkSize, (i + 1) * st.chunkSize).toString('base64')
      const r = await admin('POST', '/media/upload/chunk', { uploadId: st.uploadId, index: i, data })
      assert.equal(r.status, 200, JSON.stringify(r.json))
      if (i === 1) assert.equal((await admin('POST', '/media/upload/chunk', { uploadId: st.uploadId, index: 1, data })).status, 200) // retry is fine
    }
    const file = (await admin('POST', '/media/upload/finish', { uploadId: st.uploadId })).json
    assert.equal(file.size, bytes.length)
    assert.equal(file.name, 'Hello.mp3')

    // full + ranged download
    const full = await fetch(BASE + file.url)
    assert.equal(full.status, 200)
    assert.equal(full.headers.get('accept-ranges'), 'bytes')
    assert.ok(Buffer.from(await full.arrayBuffer()).equals(bytes))
    const part = await fetch(BASE + file.url, { headers: { Range: 'bytes=1000-1099' } })
    assert.equal(part.status, 206)
    assert.equal(part.headers.get('content-range'), `bytes 1000-1099/${bytes.length}`)
    assert.ok(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(1000, 1100)))

    // non-audio content is rejected at finish
    const bad = (await admin('POST', '/media/upload/start', { name: 'fake.mp3', size: 4, mime: 'audio/mpeg' })).json
    await admin('POST', '/media/upload/chunk', { uploadId: bad.uploadId, index: 0, data: Buffer.from('<?ph').toString('base64') })
    assert.equal((await admin('POST', '/media/upload/finish', { uploadId: bad.uploadId })).status, 422)

    // settings: admin only; welcome music used everywhere
    assert.equal((await op1('POST', '/media/settings', { welcomeMusic: file.id })).status, 403)
    const set = await admin('POST', '/media/settings', { welcomeMusic: file.id, pauseMusic: file.id })
    assert.equal(set.status, 200, JSON.stringify(set.json))
    assert.equal(set.json.welcomeMusic.id, file.id)
    assert.equal((await op1('GET', '/media/settings')).json.pauseMusic.url, file.url)

    // a paired screen gets the URLs and reports what its speakers do
    const req = (await anon('POST', '/display/pairing', {})).json
    await admin('POST', '/pairing/approve', { code: req.code, sessionId: sid, label: 'Media screen' })
    const tok = (await anon('GET', `/display/pairing/${req.pairingId}`)).json.token
    const disp = client()
    const H = { 'X-Display-Token': tok }
    const pub = (await disp('GET', '/display/state', undefined, H)).json
    assert.equal(pub.media.welcomeMusic, file.url)
    assert.equal(pub.media.welcomeImage, null)
    const hb = await disp('POST', '/display/heartbeat', { appliedVersion: pub.stateVersion, audio: 'blocked' }, H)
    assert.equal(hb.json.media.pauseMusic, file.url)
    const dev = (await admin('GET', `/sessions/${sid}/view`)).json.devices.find((d) => d.label === 'Media screen')
    assert.equal(dev.audioStatus, 'blocked')
  })
})
