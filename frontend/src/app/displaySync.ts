import { useCallback, useEffect, useRef, useState } from 'react'
import { initialSync, reduceSync, type SyncState } from '../engine/displaySync'
import { readFaults } from '../engine/faults'
import { ApiError, type DisplayOverlay, type PublicDisplayState } from '../engine/types'
import { setWorkerInterval } from '../lib/workerTimer'
import { bus, kv, server } from './server'

export interface DisplayCredential {
  token: string
  sessionId: string
  deviceId: string
}

const CRED_KEY = 'gl-auction-display-credential'

export function loadCredential(): DisplayCredential | null {
  try {
    const raw = localStorage.getItem(CRED_KEY)
    return raw ? (JSON.parse(raw) as DisplayCredential) : null
  } catch {
    return null
  }
}
export function saveCredential(c: DisplayCredential | null) {
  try {
    if (c) localStorage.setItem(CRED_KEY, JSON.stringify(c))
    else localStorage.removeItem(CRED_KEY)
  } catch {
    /* ignore */
  }
}

const HEARTBEAT_MS = 2000
const LOST_AFTER_MS = 5000

/**
 * Room display client (REALTIME.md §4): snapshot on start, versioned messages,
 * gap detection → snapshot, heartbeat with server version check, ACK after
 * render, exponential-backoff reconnect, and an explicit unhealthy overlay.
 */
export function useDisplaySync(cred: DisplayCredential | null) {
  const syncRef = useRef<SyncState>(initialSync)
  const [state, setState] = useState<PublicDisplayState | null>(null)
  const [overlay, setOverlay] = useState<DisplayOverlay>('NONE')
  const [unpaired, setUnpaired] = useState(false)
  const lastOk = useRef(Date.now())
  const failing = useRef(false)
  const backoff = useRef(0)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const token = cred?.token ?? null

  const markOk = () => {
    lastOk.current = Date.now()
    failing.current = false
    backoff.current = 0
  }

  const apply = useCallback(
    (kind: 'snapshot' | 'message', s: PublicDisplayState) => {
      const { next, outcome } = reduceSync(syncRef.current, { kind, state: s })
      if (outcome === 'applied') {
        syncRef.current = next
        setState(next.applied)
        // ACK after the frame is painted.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (token) server.display.ack(token, next.appliedVersion).catch(() => {})
          }),
        )
      }
      return outcome
    },
    [token],
  )

  const snapshot = useCallback(async () => {
    if (!token) return
    try {
      const s = await server.display.getPublicState(token)
      markOk()
      apply('snapshot', s)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'UNAUTHENTICATED') return setUnpaired(true)
      failing.current = true
      scheduleReconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, apply])

  const scheduleReconnect = () => {
    if (retryTimer.current) return
    const base = Math.min(500 * 2 ** backoff.current, 15_000)
    const delay = base * (0.8 + Math.random() * 0.4)
    backoff.current += 1
    retryTimer.current = setTimeout(() => {
      retryTimer.current = null
      void snapshot()
    }, delay)
  }

  // Initial snapshot + resync on tab visibility
  useEffect(() => {
    if (!token) return
    void snapshot()
    const onVis = () => document.visibilityState === 'visible' && void snapshot()
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [token, snapshot])

  // Real-time messages ("WebSocket")
  useEffect(() => {
    if (!cred) return
    return bus.subscribe((m) => {
      if (readFaults(kv).displayOffline) return // socket is down
      if (m.type === 'state.updated' && m.sessionId === cred.sessionId) {
        const outcome = apply('message', m.payload)
        if (outcome === 'gap') void snapshot()
        else lastOk.current = Date.now()
      } else if (m.type === 'display.resync' && m.sessionId === cred.sessionId) void snapshot()
      else if (m.type === 'device.revoked' && m.deviceId === cred.deviceId) void snapshot()
    })
  }, [cred, apply, snapshot])

  // Heartbeat + server-version check (also our HTTP polling fallback)
  useEffect(() => {
    if (!token) return
    const beat = async () => {
      try {
        const { serverVersion } = await server.display.heartbeat(token, syncRef.current.appliedVersion)
        markOk()
        if (serverVersion > syncRef.current.appliedVersion) void snapshot()
      } catch (e) {
        if (e instanceof ApiError && e.code === 'UNAUTHENTICATED') return setUnpaired(true)
        failing.current = true
        scheduleReconnect()
      }
    }
    void beat()
    return setWorkerInterval(() => void beat(), HEARTBEAT_MS)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, snapshot])

  // Overlay evaluation
  useEffect(() => {
    const t = setInterval(() => {
      const since = Date.now() - lastOk.current
      setOverlay(since >= LOST_AFTER_MS ? 'CONNECTION_LOST' : failing.current ? 'RECONNECTING' : 'NONE')
    }, 250)
    return () => clearInterval(t)
  }, [])

  return { state, overlay, unpaired }
}
