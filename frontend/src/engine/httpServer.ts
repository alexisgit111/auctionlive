/**
 * HTTP implementation of AppServer → PHP API at /api/index.php?r=/route.
 * Same method signatures as the mock, so UI code is unchanged.
 */
import type { AppServer, AuthApi, ManagedUser, MediaApi, MediaFile, MediaSettingsView } from './api'
import type { ExecuteResponse, SessionInput, SessionSummary, StaffView } from './mockServer'
import {
  ApiError,
  type AuctionEvent,
  type Bid,
  type Command,
  type Device,
  type DeviceSummary,
  type ErrorCode,
  type OperatorLease,
  type AudioStatus,
  type Pairing,
  type RoomMedia,
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
    health: () => call<{ ok: boolean; serverNow: string; apiVersion?: number }>('GET', '/health'),
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
    listDevices: () => call<DeviceSummary[]>('GET', '/devices'),
    moveDevice: (deviceId: string, sessionId: string) => call<Device>('POST', `/devices/${enc(deviceId)}/move`, { sessionId }),
    // The display polls the server every second, so a resync is just "check now".
    requestResync: async () => {},
    relayOutbox: async () => 0,
  } as unknown as AppServer['staff']

  const display: AppServer['display'] = {
    requestPairing: () => call('POST', '/display/pairing', {}),
    // replaceToken: this screen's current credential — retired once the new pairing is claimed.
    pollPairing: (pairingId: string, replaceToken?: string | null) =>
      call<{ status: Pairing['status']; token?: string; sessionId?: string; deviceId?: string }>(
        'GET',
        `/display/pairing/${enc(pairingId)}`,
        undefined,
        replaceToken ?? null,
      ),
    getPublicState: (token: string | null) => call<PublicDisplayState>('GET', '/display/state', undefined, token),
    // With wait=true the server answers as soon as anything changes (long poll, ≤ ~3.5 s).
    heartbeat: (token: string | null, appliedVersion: number, opts?: { wait?: boolean; sessionId?: string; audio?: AudioStatus }) =>
      call<{ serverVersion: number; sessionId: string; media: RoomMedia }>(
        'POST',
        '/display/heartbeat',
        { appliedVersion, wait: !!opts?.wait, sessionId: opts?.sessionId ?? '', audio: opts?.audio },
        token,
      ),
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

  const media: MediaApi = {
    get: () => call<MediaSettingsView>('GET', '/media/settings'),
    set: (patch) => call<MediaSettingsView>('POST', '/media/settings', patch),
    async uploadMusic(file, onProgress) {
      const start = await call<{ uploadId: string; chunkSize: number }>('POST', '/media/upload/start', {
        name: file.name,
        size: file.size,
        mime: file.type || (file.name.toLowerCase().endsWith('.mp3') ? 'audio/mpeg' : ''),
      })
      const n = Math.ceil(file.size / start.chunkSize)
      for (let i = 0; i < n; i++) {
        const blob = file.slice(i * start.chunkSize, (i + 1) * start.chunkSize)
        const data = await blobToBase64(blob)
        // a dropped connection retries the same chunk (the server accepts it again)
        for (let attempt = 0; ; attempt++) {
          try {
            await call('POST', '/media/upload/chunk', { uploadId: start.uploadId, index: i, data })
            break
          } catch (e) {
            if (attempt >= 2) throw e
            await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
          }
        }
        onProgress?.((i + 1) / n)
      }
      return call<MediaFile>('POST', '/media/upload/finish', { uploadId: start.uploadId })
    },
  }

  return {
    mode: 'http',
    staff,
    display,
    auth,
    media,
    uploadImage: async (dataUrl) => (await call<{ ref: string }>('POST', '/images', { dataUrl })).ref,
    ensureSeed: async () => {},
    resetAll: () => {},
    displayPollMs: 1000,
    displayLongPoll: true,
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result).replace(/^data:[^,]*,/, ''))
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(blob)
  })
}
