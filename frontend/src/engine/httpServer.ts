/**
 * HTTP implementation of AppServer → PHP API at /api/index.php?r=/route.
 * Same method signatures as the mock, so UI code is unchanged.
 */
import type { AppServer, AuthApi, ManagedUser } from './api'
import type { ExecuteResponse, SessionInput, SessionSummary, StaffView } from './mockServer'
import {
  ApiError,
  type AuctionEvent,
  type Bid,
  type Command,
  type Device,
  type ErrorCode,
  type OperatorLease,
  type Pairing,
  type PublicDisplayState,
  type Session,
  type User,
} from './types'

const TIMEOUT_MS = 10_000

export function createHttpServer(base = ''): AppServer {
  const endpoint = `${base}/api/index.php`

  async function call<T>(method: 'GET' | 'POST', route: string, body?: unknown, displayToken?: string | null): Promise<T> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    let res: Response
    try {
      // Unique URL per GET so no proxy cache (e.g. Cloudways Varnish) can ever serve a stale auction state.
      const bust = method === 'GET' ? `&_=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` : ''
      res = await fetch(`${endpoint}?r=${encodeURIComponent(route)}${bust}`, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: ctrl.signal,
        headers: {
          'X-Requested-With': 'auction-live',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(displayToken ? { 'X-Display-Token': displayToken } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch {
      // Offline, DNS failure, timeout — the request may or may not have reached the server.
      throw new ApiError('NETWORK_ERROR', 'Cannot reach Auction Live cloud', 0)
    } finally {
      clearTimeout(timer)
    }
    let json: unknown = null
    try {
      json = await res.json()
    } catch {
      if (!res.ok) throw new ApiError('NETWORK_ERROR', `Server error (${res.status})`, res.status)
    }
    if (!res.ok) {
      const e = (json as { error?: { code: ErrorCode; message: string; details?: Record<string, unknown> } })?.error
      throw new ApiError(e?.code ?? 'NETWORK_ERROR', e?.message ?? `Server error (${res.status})`, res.status, e?.details ?? undefined)
    }
    return json as T
  }

  const enc = encodeURIComponent

  const staff: AppServer['staff'] = {
    health: () => call('GET', '/health'),
    listSessions: () => call<SessionSummary[]>('GET', '/sessions'),
    createSession: (input: SessionInput) => call<Session>('POST', '/sessions', input),
    updateSession: (id: string, input: SessionInput) => call<Session>('POST', `/sessions/${enc(id)}`, input),
    getStaffView: (sid: string) => call<StaffView>('GET', `/sessions/${enc(sid)}/view`),
    getEvents: (sid: string) => call<AuctionEvent[]>('GET', `/sessions/${enc(sid)}/events`),
    getBids: (sid: string) => call<Bid[]>('GET', `/sessions/${enc(sid)}/bids`),
    getIdempotency: (key: string) => call('GET', `/idempotency/${enc(key)}`),
    execute: (sid: string, cmd: Command, opts: { idempotencyKey: string; expectedVersion: number; leaseToken: string | null }) =>
      call<ExecuteResponse>('POST', `/sessions/${enc(sid)}/execute`, {
        cmd,
        idempotencyKey: opts.idempotencyKey,
        expectedVersion: opts.expectedVersion,
        leaseToken: opts.leaseToken,
      }),
    acquireLease: (sid: string) => call<OperatorLease>('POST', `/sessions/${enc(sid)}/lease`, {}),
    renewLease: (sid: string, leaseToken: string) => call<OperatorLease>('POST', `/sessions/${enc(sid)}/lease/renew`, { leaseToken }),
    releaseLease: async (sid: string, leaseToken: string) => {
      await call('POST', `/sessions/${enc(sid)}/lease/release`, { leaseToken })
    },
    takeoverLease: (sid: string, _user: User, reason: string) =>
      call<OperatorLease>('POST', `/sessions/${enc(sid)}/lease/takeover`, { reason }),
    approvePairing: (code: string, sessionId: string, label: string) => call<Device>('POST', '/pairing/approve', { code, sessionId, label }),
    revokeDevice: async (deviceId: string) => {
      await call('POST', `/devices/${enc(deviceId)}/revoke`, {})
    },
    // The display polls the server every second, so a resync is just "check now".
    requestResync: async () => {},
    relayOutbox: async () => 0,
  } as unknown as AppServer['staff']

  const display: AppServer['display'] = {
    requestPairing: () => call('POST', '/display/pairing', {}),
    pollPairing: (pairingId: string) =>
      call<{ status: Pairing['status']; token?: string; sessionId?: string; deviceId?: string }>('GET', `/display/pairing/${enc(pairingId)}`),
    getPublicState: (token: string | null) => call<PublicDisplayState>('GET', '/display/state', undefined, token),
    heartbeat: (token: string | null, appliedVersion: number) =>
      call<{ serverVersion: number }>('POST', '/display/heartbeat', { appliedVersion }, token),
    ack: async (token: string | null, version: number) => {
      await call('POST', '/display/ack', { version }, token)
    },
  }

  const auth: AuthApi = {
    async me() {
      try {
        return (await call<{ user: User }>('GET', '/auth/me')).user
      } catch (e) {
        if (e instanceof ApiError && e.code === 'UNAUTHENTICATED') return null
        throw e
      }
    },
    login: async (email, password) => (await call<{ user: User }>('POST', '/auth/login', { email, password })).user,
    logout: async () => {
      await call('POST', '/auth/logout', {})
    },
    setupStatus: () => call('GET', '/setup/status'),
    setupAdmin: async (input) => {
      await call('POST', '/setup/admin', input)
    },
    listUsers: () => call<ManagedUser[]>('GET', '/users'),
    createUser: (input) => call<ManagedUser>('POST', '/users', input),
    updateUser: (id, patch) => call<ManagedUser>('POST', `/users/${enc(id)}`, patch),
    changePassword: async (currentPassword, newPassword) => {
      await call('POST', '/auth/password', { currentPassword, newPassword })
    },
  }

  return {
    mode: 'http',
    staff,
    display,
    auth,
    uploadImage: async (dataUrl) => (await call<{ ref: string }>('POST', '/images', { dataUrl })).ref,
    ensureSeed: async () => {},
    resetAll: () => {},
    displayPollMs: 1000,
  }
}
