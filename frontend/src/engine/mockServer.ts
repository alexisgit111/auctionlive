/**
 * Phase 1A in-browser "authoritative backend".
 *
 * It follows the same 8-step mutation protocol as the planned Laravel service
 * (REALTIME.md §2): lease check → idempotency → lock → version check →
 * state machine → audit event → version++ / outbox → commit → relay broadcast.
 *
 * Storage is localStorage (shared by every tab of this origin) and the lock is
 * the Web Locks API, so two browser windows behave like two separate computers
 * talking to one server.
 */
import { formatCents } from '../lib/money'
import { pairingCode, sha256, ulid, uuid } from '../lib/ids'
import type { Bus } from './bus'
import { applyCommand, initialState, snapshot } from './engine'
import { readFaults, type Faults } from './faults'
import { toPublicState } from './publicState'
import type { KV, LockFn } from './storage'
import {
  ApiError,
  type AuctionEvent,
  type AuctionState,
  type Bid,
  type Command,
  type Device,
  type EventType,
  type OperatorLease,
  type Pairing,
  type Salesperson,
  MAX_SALESPEOPLE,
  type PublicDisplayState,
  type Session,
  type User,
} from './types'

export const LEASE_TTL_MS = 15_000
export const PAIRING_TTL_MS = 5 * 60_000

interface IdemRecord {
  key: string
  userId: string
  requestHash: string
  status: 'COMPLETED' | 'FAILED'
  response?: ExecuteResponse
  error?: { code: ApiError['code']; message: string; status: number; details?: Record<string, unknown> }
  createdAt: string
}

interface OutboxRow {
  id: number
  sessionId: string
  version: number
  payload: PublicDisplayState
  createdAt: string
  publishedAt: string | null
  attempts: number
}

export interface Db {
  schema: 1
  users: User[]
  sessions: Record<string, Session>
  states: Record<string, AuctionState>
  bids: Record<string, Bid[]>
  events: Record<string, AuctionEvent[]>
  leases: Record<string, OperatorLease | null>
  devices: Record<string, Device>
  pairings: Record<string, Pairing>
  idempotency: Record<string, IdemRecord>
  outbox: OutboxRow[]
  outboxSeq: number
}

export interface ExecuteResponse {
  state: AuctionState
  bid?: Bid
}

export interface StaffView {
  session: Session
  state: AuctionState
  bids: Bid[]
  lease: OperatorLease | null
  devices: Device[]
  serverNow: string
}

export interface SessionSummary {
  session: Session
  state: AuctionState
}

export interface SessionInput {
  title: string
  scheduledAt: string
  auctioneerName: string
  salespeople: Salesperson[]
  defaultIncrementCents: string
  reserveCents: string | null
  internalNotes: string
  property: Session['property']
}

const DB_KEY = 'gl-auction-db-v1'

export const DEMO_USERS: User[] = [
  { id: 'u-op-1', name: 'Operator 1', role: 'operator' },
  { id: 'u-op-2', name: 'Operator 2', role: 'operator' },
  { id: 'u-admin', name: 'Auction Admin', role: 'admin' },
]

export interface ServerDeps {
  kv: KV
  lock: LockFn
  bus: Bus
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

export type MockServer = ReturnType<typeof createMockServer>

export function createMockServer(deps: ServerDeps) {
  const { kv, lock, bus } = deps
  const nowMs = deps.now ?? (() => Date.now())
  const iso = () => new Date(nowMs()).toISOString()
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = deps.random ?? Math.random

  // ───────────────────────── persistence ─────────────────────────
  function emptyDb(): Db {
    return {
      schema: 1,
      users: DEMO_USERS,
      sessions: {},
      states: {},
      bids: {},
      events: {},
      leases: {},
      devices: {},
      pairings: {},
      idempotency: {},
      outbox: [],
      outboxSeq: 0,
    }
  }

  function load(): Db {
    const raw = kv.get(DB_KEY)
    if (!raw) return emptyDb()
    try {
      return JSON.parse(raw) as Db
    } catch {
      return emptyDb()
    }
  }

  function read(): Db {
    return load()
  }

  /** Serialised read-modify-write. Throwing inside `fn` rolls back (nothing is saved). */
  async function tx<T>(fn: (db: Db) => T | Promise<T>): Promise<T> {
    return lock('gl-auction-db', async () => {
      const db = load()
      const result = await fn(db)
      compact(db)
      try {
        kv.set(DB_KEY, JSON.stringify(db))
      } catch (e) {
        // Storage full: compact aggressively and retry once. If it still fails, nothing is saved (rollback).
        compact(db, true)
        try {
          kv.set(DB_KEY, JSON.stringify(db))
        } catch {
          throw new ApiError(
            'STORAGE_FULL',
            'Local prototype storage is full — nothing was saved. Export reports, then use Sessions → Reset prototype data.',
            507,
            { cause: String(e) },
          )
        }
      }
      return result
    })
  }

  /**
   * Keep the prototype database small. Published outbox rows are only needed briefly
   * (the real backend keeps them in MySQL); idempotency records are needed only for retries.
   * Audit events and bids are NEVER pruned.
   */
  function compact(db: Db, aggressive = false) {
    const keepPublished = aggressive ? 0 : 20
    const published = db.outbox.filter((r) => r.publishedAt)
    db.outbox = db.outbox.filter((r) => !r.publishedAt).concat(published.slice(published.length - keepPublished))
    db.outbox.sort((a, b) => a.id - b.id)
    for (const r of db.outbox) {
      // Never keep inline image data in the queue (legacy rows).
      if (r.payload.property.heroImage?.startsWith('data:')) r.payload.property.heroImage = null
      for (const p of r.payload.salespeople ?? []) if (p.photo?.startsWith('data:')) p.photo = null
    }
    const keys = Object.values(db.idempotency).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const maxIdem = aggressive ? 50 : 300
    for (const k of keys.slice(0, Math.max(0, keys.length - maxIdem))) delete db.idempotency[k.key]
    for (const [id, p] of Object.entries(db.pairings)) if (p.status !== 'PENDING' && p.status !== 'APPROVED') delete db.pairings[id]
  }

  // ───────────────────────── network simulation ─────────────────────────
  const faults = (): Faults => readFaults(kv)

  async function staffNet() {
    const f = faults()
    await sleep(f.latencyMs)
    if (f.consoleOffline) throw new ApiError('NETWORK_ERROR', 'Cannot reach Auction Live cloud', 0)
  }
  async function displayNet() {
    const f = faults()
    await sleep(Math.min(f.latencyMs, 80))
    if (f.displayOffline) throw new ApiError('NETWORK_ERROR', 'Display cannot reach Auction Live cloud', 0)
  }

  // ───────────────────────── helpers ─────────────────────────
  function requireSession(db: Db, id: string) {
    const s = db.sessions[id]
    if (!s) throw new ApiError('NOT_FOUND', 'Session not found', 404)
    return s
  }

  function activeLease(db: Db, sessionId: string): OperatorLease | null {
    const l = db.leases[sessionId]
    if (!l || l.releasedAt) return null
    if (Date.parse(l.expiresAt) <= nowMs()) return null
    return l
  }

  function appendEvent(
    db: Db,
    sessionId: string,
    type: EventType,
    operatorId: string | null,
    opts: { reason?: string | null; data?: AuctionEvent['data']; idempotencyKey?: string | null } = {},
  ) {
    const st = db.states[sessionId]
    st.eventSeq += 1
    const snap = snapshot(st)
    const ev: AuctionEvent = {
      sessionId,
      seq: st.eventSeq,
      type,
      previousState: snap,
      newState: snap,
      operatorId,
      serverTimestamp: iso(),
      stateVersion: st.stateVersion,
      reason: opts.reason ?? null,
      idempotencyKey: opts.idempotencyKey ?? null,
      data: opts.data ?? null,
    }
    ;(db.events[sessionId] ??= []).push(ev)
  }

  function enqueueOutbox(db: Db, sessionId: string) {
    const st = db.states[sessionId]
    db.outboxSeq += 1
    db.outbox.push({
      id: db.outboxSeq,
      sessionId,
      version: st.stateVersion,
      payload: toPublicState(db.sessions[sessionId], st, iso()),
      createdAt: iso(),
      publishedAt: null,
      attempts: 0,
    })
    // keep outbox bounded in the prototype
  }

  // ───────────────────────── outbox relay (broadcast after commit) ─────────────────────────
  let held: OutboxRow | null = null
  let heldTimer: ReturnType<typeof setTimeout> | null = null

  function deliver(row: OutboxRow) {
    const f = faults()
    const send = () =>
      bus.publish({ type: 'state.updated', sessionId: row.sessionId, version: row.version, payload: row.payload })
    if (random() < f.dropRate) return // lost in transit
    const fire = () => {
      send()
      if (f.duplicate) setTimeout(send, 30)
    }
    if (f.reorder) {
      if (held) {
        const prev = held
        held = null
        if (heldTimer) clearTimeout(heldTimer)
        // deliver newer first, then the older one → out-of-order arrival
        setTimeout(fire, f.delayMs)
        setTimeout(
          () => bus.publish({ type: 'state.updated', sessionId: prev.sessionId, version: prev.version, payload: prev.payload }),
          f.delayMs + 40,
        )
      } else {
        held = row
        heldTimer = setTimeout(() => {
          if (held) {
            const h = held
            held = null
            bus.publish({ type: 'state.updated', sessionId: h.sessionId, version: h.version, payload: h.payload })
          }
        }, 3000)
      }
      return
    }
    if (f.delayMs > 0) setTimeout(fire, f.delayMs)
    else fire()
  }

  async function relayOutbox(): Promise<number> {
    if (faults().relayDown) return 0
    const rows = await tx((db) => {
      const pending = db.outbox.filter((r) => !r.publishedAt).sort((a, b) => a.id - b.id)
      for (const r of pending) {
        r.publishedAt = iso()
        r.attempts += 1
      }
      return pending
    })
    rows.forEach(deliver)
    return rows.length
  }

  function notifyStaff(sessionId: string) {
    bus.publish({ type: 'staff.changed', sessionId })
  }

  // ───────────────────────── seed ─────────────────────────
  async function ensureSeed() {
    if (kv.get(DB_KEY)) return
    await tx((db) => {
      if (Object.keys(db.sessions).length) return
      const id = ulid(nowMs())
      const now = iso()
      db.sessions[id] = {
        id,
        title: 'Demo auction',
        scheduledAt: now,
        auctioneerName: 'Auctioneer',
        salespeople: [],
        defaultIncrementCents: (10_000n * 100n).toString(),
        reserveCents: (1_300_000n * 100n).toString(),
        internalNotes: 'Demo session for Phase 1A testing.',
        property: {
          addressLine: '12 Example Road',
          suburb: 'Flat Bush',
          city: 'Auckland',
          heroImage: null,
          bedrooms: 4,
          bathrooms: 3,
          parking: 2,
          landAreaM2: 622,
          floorAreaM2: null,
          badge: '',
        },
        createdAt: now,
        createdBy: 'u-admin',
      }
      db.states[id] = initialState(id, now)
      db.bids[id] = []
      db.events[id] = []
      db.leases[id] = null
    })
  }

  // ═════════════════════════ STAFF API ═════════════════════════
  const staff = {
    async health() {
      await staffNet()
      return { ok: true, serverNow: iso() }
    },

    async listSessions(): Promise<SessionSummary[]> {
      await staffNet()
      const db = read()
      return Object.values(db.sessions)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((session) => ({ session, state: db.states[session.id] }))
    },

    async createSession(input: SessionInput, user: User): Promise<Session> {
      await staffNet()
      if (user.role !== 'admin') throw new ApiError('FORBIDDEN', 'Only admins can create sessions', 403)
      validateSessionInput(input)
      return tx((db) => {
        const id = ulid(nowMs())
        const now = iso()
        const s: Session = { id, ...input, createdAt: now, createdBy: user.id }
        db.sessions[id] = s
        db.states[id] = initialState(id, now)
        db.bids[id] = []
        db.events[id] = []
        db.leases[id] = null
        return s
      })
    },

    async updateSession(id: string, input: SessionInput, user: User): Promise<Session> {
      await staffNet()
      if (user.role !== 'admin') throw new ApiError('FORBIDDEN', 'Only admins can edit sessions', 403)
      validateSessionInput(input)
      const s = await tx((db) => {
        const s = requireSession(db, id)
        Object.assign(s, input)
        // Public fields (address/image) may change → push a fresh public state at same version.
        enqueueOutbox(db, id)
        return s
      })
      void relayOutbox()
      notifyStaff(id)
      return s
    },

    async getStaffView(sessionId: string): Promise<StaffView> {
      await staffNet()
      const db = read()
      const session = requireSession(db, sessionId)
      return {
        session,
        state: db.states[sessionId],
        bids: [...(db.bids[sessionId] ?? [])].sort((a, b) => b.seq - a.seq),
        lease: activeLease(db, sessionId),
        devices: Object.values(db.devices).filter((d) => d.sessionId === sessionId),
        serverNow: iso(),
      }
    },

    async getEvents(sessionId: string): Promise<AuctionEvent[]> {
      await staffNet()
      const db = read()
      requireSession(db, sessionId)
      return [...(db.events[sessionId] ?? [])]
    },

    async getBids(sessionId: string): Promise<Bid[]> {
      await staffNet()
      return [...(read().bids[sessionId] ?? [])].sort((a, b) => a.seq - b.seq)
    },

    /** Query whether an earlier request committed (lost-response recovery). */
    async getIdempotency(key: string): Promise<{ status: 'UNKNOWN' | 'COMPLETED' | 'FAILED'; response?: ExecuteResponse }> {
      await staffNet()
      const rec = read().idempotency[key]
      if (!rec) return { status: 'UNKNOWN' }
      return { status: rec.status, response: rec.response }
    },

    async execute(
      sessionId: string,
      cmd: Command,
      opts: { idempotencyKey: string; expectedVersion: number; leaseToken: string | null; user: User },
    ): Promise<ExecuteResponse> {
      await staffNet()
      const requestHash = JSON.stringify({ sessionId, cmd, expectedVersion: opts.expectedVersion })

      const result = await tx((db) => {
        // 1. idempotency replay
        const prior = db.idempotency[opts.idempotencyKey]
        if (prior) {
          if (prior.requestHash !== requestHash || prior.userId !== opts.user.id)
            throw new ApiError('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used for a different request', 409)
          if (prior.status === 'COMPLETED') return { replay: true as const, response: prior.response! }
          const e = prior.error!
          throw new ApiError(e.code, e.message, e.status, e.details)
        }

        const record = (r: Omit<IdemRecord, 'key' | 'userId' | 'requestHash' | 'createdAt'>) => {
          db.idempotency[opts.idempotencyKey] = {
            key: opts.idempotencyKey,
            userId: opts.user.id,
            requestHash,
            createdAt: iso(),
            ...r,
          }
        }

        try {
          requireSession(db, sessionId)
          // 2. operator lease
          const lease = activeLease(db, sessionId)
          if (!lease) throw new ApiError('LEASE_REQUIRED', 'Acquire operator control first', 423)
          if (lease.leaseToken !== opts.leaseToken || lease.userId !== opts.user.id)
            throw new ApiError('LEASE_HELD_BY_OTHER', `${lease.userName} has operator control`, 423)
          // 3. version check
          const st = db.states[sessionId]
          if (st.stateVersion !== opts.expectedVersion)
            throw new ApiError('VERSION_CONFLICT', 'Auction state changed — review and try again', 409, {
              currentVersion: st.stateVersion,
            })
          // 4–6. state machine + audit event + version++
          const r = applyCommand(st, db.bids[sessionId] ?? [], cmd, {
            operatorId: opts.user.id,
            now: iso(),
            idempotencyKey: opts.idempotencyKey,
            newId: () => ulid(nowMs()),
          })
          db.states[sessionId] = r.state
          db.bids[sessionId] = r.bids
          ;(db.events[sessionId] ??= []).push(...r.events)
          // 7. outbox
          enqueueOutbox(db, sessionId)
          const response: ExecuteResponse = { state: r.state, bid: r.bid }
          record({ status: 'COMPLETED', response })
          return { replay: false as const, response }
        } catch (e) {
          // Business errors are stored so a retry with the same key gets the same answer.
          if (e instanceof ApiError && e.code !== 'NETWORK_ERROR') {
            record({ status: 'FAILED', error: { code: e.code, message: e.message, status: e.status, details: e.details } })
            // Persist the failed record (we must not throw out of tx, or it rolls back).
            return { replay: false as const, error: e }
          }
          throw e
        }
      })

      if ('error' in result && result.error) throw result.error
      // 8. broadcast after commit
      if (!result.replay) {
        void relayOutbox()
        notifyStaff(sessionId)
      }
      const f = faults()
      if (f.loseNextResponse && !result.replay) {
        kv.set('gl-auction-faults-v1', JSON.stringify({ ...f, loseNextResponse: false }))
        throw new ApiError('RESPONSE_LOST', 'Response lost after commit (simulated)', 0)
      }
      return result.response!
    },

    // ─── operator lease ───
    async acquireLease(sessionId: string, user: User): Promise<OperatorLease> {
      await staffNet()
      const lease = await tx((db) => {
        requireSession(db, sessionId)
        const cur = activeLease(db, sessionId)
        if (cur && cur.userId !== user.id)
          throw new ApiError('LEASE_HELD_BY_OTHER', `${cur.userName} has operator control`, 423, {
            holder: cur.userName,
            expiresAt: cur.expiresAt,
          })
        const now = iso()
        const l: OperatorLease = {
          sessionId,
          userId: user.id,
          userName: user.name,
          leaseToken: uuid(),
          acquiredAt: now,
          renewedAt: now,
          expiresAt: new Date(nowMs() + LEASE_TTL_MS).toISOString(),
          releasedAt: null,
        }
        db.leases[sessionId] = l
        appendEvent(db, sessionId, 'OPERATOR_ACQUIRED', user.id, { data: { reacquired: cur ? 1 : 0 } })
        return l
      })
      notifyStaff(sessionId)
      return lease
    },

    async renewLease(sessionId: string, leaseToken: string, user: User): Promise<OperatorLease> {
      await staffNet()
      return tx((db) => {
        const cur = activeLease(db, sessionId)
        if (!cur || cur.leaseToken !== leaseToken || cur.userId !== user.id)
          throw new ApiError('LEASE_EXPIRED', 'Operator control has been lost', 423)
        cur.renewedAt = iso()
        cur.expiresAt = new Date(nowMs() + LEASE_TTL_MS).toISOString()
        return { ...cur }
      })
    },

    async releaseLease(sessionId: string, leaseToken: string, user: User) {
      await staffNet()
      await tx((db) => {
        const cur = activeLease(db, sessionId)
        if (!cur || cur.leaseToken !== leaseToken) return
        cur.releasedAt = iso()
        appendEvent(db, sessionId, 'OPERATOR_RELEASED', user.id)
      })
      notifyStaff(sessionId)
    },

    async takeoverLease(sessionId: string, user: User, reason: string): Promise<OperatorLease> {
      await staffNet()
      if (user.role !== 'admin') throw new ApiError('FORBIDDEN', 'Only an admin can take over control', 403)
      if (!reason.trim()) throw new ApiError('VALIDATION_FAILED', 'A reason is required for takeover', 422)
      const lease = await tx((db) => {
        requireSession(db, sessionId)
        const prev = activeLease(db, sessionId)
        const now = iso()
        if (prev) prev.releasedAt = now
        const l: OperatorLease = {
          sessionId,
          userId: user.id,
          userName: user.name,
          leaseToken: uuid(),
          acquiredAt: now,
          renewedAt: now,
          expiresAt: new Date(nowMs() + LEASE_TTL_MS).toISOString(),
          releasedAt: null,
        }
        db.leases[sessionId] = l
        appendEvent(db, sessionId, 'OPERATOR_TAKEOVER', user.id, {
          reason: reason.trim(),
          data: { fromUserId: prev?.userId ?? null, fromUserName: prev?.userName ?? null },
        })
        return l
      })
      notifyStaff(sessionId)
      return lease
    },

    // ─── display pairing (staff side) ───
    async approvePairing(code: string, sessionId: string, label: string, user: User): Promise<Device> {
      await staffNet()
      const normalized = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
      const token = uuid() + uuid()
      const tokenHash = await sha256(token)
      const device = await tx((db) => {
        requireSession(db, sessionId)
        const p = Object.values(db.pairings).find((x) => x.code === normalized && x.status === 'PENDING')
        if (!p) throw new ApiError('NOT_FOUND', 'Pairing code not found or already used', 404)
        if (Date.parse(p.expiresAt) <= nowMs()) {
          p.status = 'EXPIRED'
          throw new ApiError('VALIDATION_FAILED', 'Pairing code has expired', 422)
        }
        const now = iso()
        const d: Device = {
          id: ulid(nowMs()),
          sessionId,
          label: label.trim() || 'Room display',
          tokenHash,
          approvedBy: user.id,
          approvedAt: now,
          revokedAt: null,
          lastHeartbeatAt: null,
          lastAckedVersion: -1,
          lastAckedAt: null,
        }
        db.devices[d.id] = d
        p.status = 'APPROVED'
        p.sessionId = sessionId
        p.deviceId = d.id
        p.pendingToken = token
        appendEvent(db, sessionId, 'DISPLAY_PAIRED', user.id, { data: { deviceId: d.id, label: d.label } })
        return d
      })
      notifyStaff(sessionId)
      return device
    },

    async revokeDevice(deviceId: string, user: User) {
      await staffNet()
      const sid = await tx((db) => {
        const d = db.devices[deviceId]
        if (!d) throw new ApiError('NOT_FOUND', 'Device not found', 404)
        d.revokedAt = iso()
        appendEvent(db, d.sessionId, 'DISPLAY_REVOKED', user.id, { data: { deviceId, label: d.label } })
        return d.sessionId
      })
      bus.publish({ type: 'device.revoked', deviceId })
      notifyStaff(sid)
    },

    async requestResync(sessionId: string) {
      await staffNet()
      await tx((db) => enqueueOutbox(db, sessionId))
      void relayOutbox()
      bus.publish({ type: 'display.resync', sessionId })
    },

    relayOutbox,
  }

  // ═════════════════════════ DISPLAY API (restricted) ═════════════════════════
  async function authDevice(db: Db, token: string | null): Promise<Device> {
    if (!token) throw new ApiError('UNAUTHENTICATED', 'Display is not paired', 401)
    const h = await sha256(token)
    const d = Object.values(db.devices).find((x) => x.tokenHash === h)
    if (!d || d.revokedAt) throw new ApiError('UNAUTHENTICATED', 'Display credential is invalid or revoked', 401)
    return d
  }

  const display = {
    async requestPairing(): Promise<{ pairingId: string; code: string; expiresAt: string }> {
      await displayNet()
      return tx((db) => {
        // expire old pairings
        for (const p of Object.values(db.pairings))
          if (p.status === 'PENDING' && Date.parse(p.expiresAt) <= nowMs()) p.status = 'EXPIRED'
        const p: Pairing = {
          id: uuid(),
          code: pairingCode(),
          createdAt: iso(),
          expiresAt: new Date(nowMs() + PAIRING_TTL_MS).toISOString(),
          status: 'PENDING',
          sessionId: null,
          deviceId: null,
          pendingToken: null,
        }
        db.pairings[p.id] = p
        return { pairingId: p.id, code: p.code, expiresAt: p.expiresAt }
      })
    },

    async pollPairing(
      pairingId: string,
    ): Promise<{ status: Pairing['status']; token?: string; sessionId?: string; deviceId?: string }> {
      await displayNet()
      return tx((db) => {
        const p = db.pairings[pairingId]
        if (!p) return { status: 'EXPIRED' as const }
        if (p.status === 'PENDING' && Date.parse(p.expiresAt) <= nowMs()) p.status = 'EXPIRED'
        if (p.status === 'APPROVED' && p.pendingToken) {
          const token = p.pendingToken
          p.pendingToken = null // token is handed out exactly once
          p.status = 'CLAIMED'
          return { status: 'APPROVED' as const, token, sessionId: p.sessionId!, deviceId: p.deviceId! }
        }
        return { status: p.status }
      })
    },

    async getPublicState(token: string | null): Promise<PublicDisplayState> {
      await displayNet()
      const db = read()
      const d = await authDevice(db, token)
      return toPublicState(db.sessions[d.sessionId], db.states[d.sessionId], iso())
    },

    async heartbeat(token: string | null, appliedVersion: number): Promise<{ serverVersion: number }> {
      await displayNet()
      const v = await tx(async (db) => {
        const d = await authDevice(db, token)
        db.devices[d.id].lastHeartbeatAt = iso()
        db.devices[d.id].lastAckedVersion = Math.max(db.devices[d.id].lastAckedVersion, appliedVersion)
        return db.states[d.sessionId].stateVersion
      })
      return { serverVersion: v }
    },

    async ack(token: string | null, version: number) {
      await displayNet()
      const sid = await tx(async (db) => {
        const d = await authDevice(db, token)
        const dev = db.devices[d.id]
        if (version > dev.lastAckedVersion) {
          dev.lastAckedVersion = version
          dev.lastAckedAt = iso()
        }
        dev.lastHeartbeatAt = iso()
        return d.sessionId
      })
      notifyStaff(sid)
    },
  }

  /** One-off upgrade: move inline (data:) photos out of the database into an external image store. */
  async function migrateInlineImages(store: (dataUrl: string) => Promise<string>): Promise<number> {
    const raw = kv.get(DB_KEY)
    if (!raw || !raw.includes('data:image')) return 0
    return tx(async (db) => {
      let n = 0
      for (const s of Object.values(db.sessions)) {
        if (s.property.heroImage?.startsWith('data:')) {
          s.property.heroImage = await store(s.property.heroImage)
          n++
        }
        for (const p of s.salespeople ?? []) {
          if (p.photo?.startsWith('data:')) {
            p.photo = await store(p.photo)
            n++
          }
        }
      }
      compact(db, true)
      for (const sid of Object.keys(db.sessions)) enqueueOutbox(db, sid)
      return n
    })
  }

  /** Prototype only: wipe all local data. */
  function resetAll() {
    kv.set(DB_KEY, JSON.stringify(emptyDb()))
  }

  return { staff, display, ensureSeed, read, migrateInlineImages, resetAll, publicFormat: formatCents }
}

function validateSessionInput(i: SessionInput) {
  if (!i.title.trim()) throw new ApiError('VALIDATION_FAILED', 'Title is required', 422)
  if (!i.property.addressLine.trim()) throw new ApiError('VALIDATION_FAILED', 'Property address is required', 422)
  if ((i.salespeople ?? []).length > MAX_SALESPEOPLE)
    throw new ApiError('VALIDATION_FAILED', `At most ${MAX_SALESPEOPLE} salespeople can be shown`, 422)
  if (!/^[1-9][0-9]*$/.test(i.defaultIncrementCents))
    throw new ApiError('VALIDATION_FAILED', 'Default increment must be a positive amount', 422)
  if (i.reserveCents !== null && !/^[1-9][0-9]*$/.test(i.reserveCents))
    throw new ApiError('VALIDATION_FAILED', 'Reserve must be a positive amount', 422)
}
