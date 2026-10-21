import { beforeEach, describe, expect, it } from 'vitest'
import { createMemoryBus } from './bus'
import { writeFaults } from './faults'
import { DEMO_USERS, createMockServer } from './mockServer'
import { createLocalLock, memoryKV } from './storage'
import { ApiError } from './types'

const [op1, op2, admin] = DEMO_USERS
const K = (k: number) => (BigInt(k) * 1000n * 100n).toString()

function setup() {
  const kv = memoryKV()
  const bus = createMemoryBus()
  let t = Date.parse('2026-10-16T00:00:00Z')
  const server = createMockServer({ kv, bus, lock: createLocalLock(), now: () => t, sleep: async () => {} })
  writeFaults(kv, { latencyMs: 0 })
  return { kv, bus, server, advance: (ms: number) => (t += ms) }
}

let env: ReturnType<typeof setup>
let sid: string
let lease: string

async function exec(cmd: Parameters<typeof env.server.staff.execute>[1], key = crypto.randomUUID(), user = op1, token = lease) {
  const v = (await env.server.staff.getStaffView(sid)).state.stateVersion
  return env.server.staff.execute(sid, cmd, { idempotencyKey: key, expectedVersion: v, leaseToken: token, user })
}

beforeEach(async () => {
  env = setup()
  await env.server.ensureSeed()
  sid = (await env.server.staff.listSessions())[0].session.id
  lease = (await env.server.staff.acquireLease(sid, op1)).leaseToken
  await exec({ type: 'START' })
})

describe('idempotency', () => {
  it('records exactly one bid when the same key is submitted twice', async () => {
    const key = crypto.randomUUID()
    const v = (await env.server.staff.getStaffView(sid)).state.stateVersion
    const opts = { idempotencyKey: key, expectedVersion: v, leaseToken: lease, user: op1 }
    const [a, b] = await Promise.all([
      env.server.staff.execute(sid, { type: 'BID', amountCents: K(900) }, opts),
      env.server.staff.execute(sid, { type: 'BID', amountCents: K(900) }, opts),
    ])
    expect(a.bid!.id).toBe(b.bid!.id)
    expect((await env.server.staff.getBids(sid)).length).toBe(1)
  })

  it('rejects key reuse with a different body', async () => {
    const key = crypto.randomUUID()
    await exec({ type: 'BID', amountCents: K(900) }, key)
    await expect(exec({ type: 'BID', amountCents: K(950) }, key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
  })

  it('recovers from a lost response by querying the key', async () => {
    writeFaults(env.kv, { loseNextResponse: true })
    const key = crypto.randomUUID()
    await expect(exec({ type: 'BID', amountCents: K(900) }, key)).rejects.toMatchObject({ code: 'RESPONSE_LOST' })
    const status = await env.server.staff.getIdempotency(key)
    expect(status.status).toBe('COMPLETED')
    expect(status.response!.state.currentBidCents).toBe(K(900))
    expect((await env.server.staff.getBids(sid)).length).toBe(1)
  })
})

describe('versioning', () => {
  it('rejects a stale expected version', async () => {
    const v = (await env.server.staff.getStaffView(sid)).state.stateVersion
    await exec({ type: 'BID', amountCents: K(900) })
    await expect(
      env.server.staff.execute(sid, { type: 'BID', amountCents: K(950) }, {
        idempotencyKey: crypto.randomUUID(),
        expectedVersion: v,
        leaseToken: lease,
        user: op1,
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  })
})

describe('operator lease', () => {
  it('blocks a second operator', async () => {
    await expect(env.server.staff.acquireLease(sid, op2)).rejects.toMatchObject({ code: 'LEASE_HELD_BY_OTHER' })
    await expect(exec({ type: 'BID', amountCents: K(900) }, undefined, op2, 'forged')).rejects.toMatchObject({
      code: 'LEASE_HELD_BY_OTHER',
    })
  })

  it('expires without renewal and can then be acquired by someone else', async () => {
    env.advance(16_000)
    await expect(exec({ type: 'BID', amountCents: K(900) })).rejects.toMatchObject({ code: 'LEASE_REQUIRED' })
    const l2 = await env.server.staff.acquireLease(sid, op2)
    expect(l2.userId).toBe(op2.id)
  })

  it('any staff account takes over in one step (no reason needed) and it is audited', async () => {
    await env.server.staff.takeoverLease(sid, op2)
    const ev = (await env.server.staff.getEvents(sid)).at(-1)!
    expect(ev.type).toBe('OPERATOR_TAKEOVER')
    expect(ev.reason).toBe('Taken over')
    await env.server.staff.takeoverLease(sid, admin, 'Operator laptop froze')
    expect((await env.server.staff.getEvents(sid)).at(-1)!.reason).toBe('Operator laptop froze')
    await expect(exec({ type: 'BID', amountCents: K(900) })).rejects.toBeInstanceOf(ApiError)
  })
})

describe('audit trail', () => {
  it('every event carries the required fields', async () => {
    await exec({ type: 'BID', amountCents: K(900) })
    await exec({ type: 'PAUSE' })
    const events = await env.server.staff.getEvents(sid)
    for (const e of events) {
      expect(e.sessionId).toBe(sid)
      expect(typeof e.seq).toBe('number')
      expect(e.type).toBeTruthy()
      expect(e.previousState).toBeTruthy()
      expect(e.newState).toBeTruthy()
      expect(e.serverTimestamp).toMatch(/Z$/)
      expect(typeof e.stateVersion).toBe('number')
    }
    const seqs = events.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
  })
})

describe('display pairing & restricted access', () => {
  it('pairs, hands the token out once, serves only public state, and honours revocation', async () => {
    const req = await env.server.display.requestPairing()
    expect((await env.server.display.pollPairing(req.pairingId)).status).toBe('PENDING')
    const dev = await env.server.staff.approvePairing(req.code.toLowerCase(), sid, 'Room A', admin)
    const claim = await env.server.display.pollPairing(req.pairingId)
    expect(claim.status).toBe('APPROVED')
    expect(claim.token).toBeTruthy()
    expect((await env.server.display.pollPairing(req.pairingId)).token).toBeUndefined()

    const pub = await env.server.display.getPublicState(claim.token!)
    expect(JSON.stringify(pub)).not.toContain('reserve')
    expect(JSON.stringify(pub)).not.toContain('internalNotes')

    await env.server.staff.revokeDevice(dev.id, admin)
    await expect(env.server.display.getPublicState(claim.token!)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
  })

  it('expires pairing codes', async () => {
    const req = await env.server.display.requestPairing()
    env.advance(5 * 60_000 + 1)
    await expect(env.server.staff.approvePairing(req.code, sid, 'x', admin)).rejects.toBeInstanceOf(ApiError)
  })
})

describe('storage footprint (regression: QuotaExceededError)', () => {
  it('stays bounded over a long auction and never duplicates the photo', async () => {
    await env.server.migrateInlineImages(async () => 'idb-image:x') // no-op: nothing inline yet
    const s = (await env.server.staff.listSessions())[0].session
    await env.server.staff.updateSession(sid, { ...s, property: { ...s.property, heroImage: 'idb-image:photo-1' } }, admin)
    for (let i = 1; i <= 150; i++) {
      await exec({ type: 'BID', amountCents: K(1000 + i) })
      await env.server.staff.relayOutbox()
    }
    const size = env.kv.get('gl-auction-db-v1')!.length
    expect(size).toBeLessThan(600_000)
    expect(env.server.read().outbox.length).toBeLessThanOrEqual(25)
    expect((await env.server.staff.getBids(sid)).length).toBe(150) // audit data never pruned
  })

  it('migrates legacy inline photos out of the database', async () => {
    const db = env.server.read()
    db.sessions[sid].property.heroImage = 'data:image/jpeg;base64,' + 'B'.repeat(200_000)
    env.kv.set('gl-auction-db-v1', JSON.stringify(db))
    const n = await env.server.migrateInlineImages(async () => 'idb-image:migrated')
    expect(n).toBe(1)
    expect(env.kv.get('gl-auction-db-v1')!).not.toContain('data:image')
    expect(env.server.read().sessions[sid].property.heroImage).toBe('idb-image:migrated')
  })

  it('reports STORAGE_FULL and rolls back when storage really is full', async () => {
    const real = env.kv.set
    env.kv.set = (k, v) => {
      if (k === 'gl-auction-db-v1') throw new Error('QuotaExceededError')
      real(k, v)
    }
    await expect(exec({ type: 'BID', amountCents: K(5000) })).rejects.toMatchObject({ code: 'STORAGE_FULL' })
    env.kv.set = real
    expect((await env.server.staff.getBids(sid)).length).toBe(0)
  })
})

describe('outbox broadcast', () => {
  it('broadcasts after commit, and catches up after a relay outage', async () => {
    await new Promise((r) => setTimeout(r, 0))
    env.bus.sent.length = 0
    writeFaults(env.kv, { relayDown: true })
    await exec({ type: 'BID', amountCents: K(900) })
    await new Promise((r) => setTimeout(r, 0))
    expect(env.bus.sent.filter((m) => m.type === 'state.updated')).toHaveLength(0)
    writeFaults(env.kv, { relayDown: false })
    const n = await env.server.staff.relayOutbox()
    expect(n).toBeGreaterThan(0)
    const versions = env.bus.sent.flatMap((m) => (m.type === 'state.updated' ? [m.version] : []))
    expect(versions.at(-1)).toBe((await env.server.staff.getStaffView(sid)).state.stateVersion)
  })
})
