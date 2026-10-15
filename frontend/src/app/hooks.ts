import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { readFaults, type Faults } from '../engine/faults'
import type { BusMessage } from '../engine/bus'
import { ApiError, type Command, type OperatorLease, type User } from '../engine/types'
import type { ExecuteResponse, StaffView } from '../engine/mockServer'
import { uuid } from '../lib/ids'
import { setWorkerInterval } from '../lib/workerTimer'
import { bus, kv, server } from './server'

export function useBus(fn: (m: BusMessage) => void) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => bus.subscribe((m) => ref.current(m)), [])
}

export function useNow(intervalMs = 500) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

export function useFaults(): Faults {
  const [f, setF] = useState(() => readFaults(kv))
  useBus((m) => {
    if (m.type === 'faults.changed') setF(readFaults(kv))
  })
  useEffect(() => {
    const t = setInterval(() => setF(readFaults(kv)), 1000)
    return () => clearInterval(t)
  }, [])
  return f
}

export type CloudStatus = 'ONLINE' | 'DEGRADED' | 'OFFLINE'

/** Separate cloud API check: ping every 2 s; OFFLINE after 5 s without success. */
export function useCloudHealth(): { status: CloudStatus; lastOkAt: number } {
  const [lastOk, setLastOk] = useState(Date.now())
  const [lastFail, setLastFail] = useState(0)
  const now = useNow(500)
  useEffect(() => {
    let alive = true
    const ping = async () => {
      try {
        await server.staff.health()
        if (alive) setLastOk(Date.now())
      } catch {
        if (alive) setLastFail(Date.now())
      }
    }
    void ping()
    const stop = setWorkerInterval(() => void ping(), 2000)
    return () => {
      alive = false
      stop()
    }
  }, [])
  const since = now - lastOk
  const status: CloudStatus = since >= 5000 ? 'OFFLINE' : lastFail > lastOk ? 'DEGRADED' : 'ONLINE'
  return { status, lastOkAt: lastOk }
}

export function useStaffView(sessionId: string | null) {
  const qc = useQueryClient()
  useBus((m) => {
    if (m.type === 'staff.changed' && m.sessionId === sessionId) void qc.invalidateQueries({ queryKey: ['staff', sessionId] })
  })
  return useQuery({
    queryKey: ['staff', sessionId],
    queryFn: () => server.staff.getStaffView(sessionId!),
    enabled: !!sessionId,
    refetchInterval: 1000,
    retry: false,
    placeholderData: (prev) => prev,
    // Never let a slow, older response overwrite a newer authoritative state.
    structuralSharing: (oldData, newData) => {
      const o = oldData as StaffView | undefined
      const n = newData as StaffView
      if (o && n && o.session.id === n.session.id && o.state.stateVersion > n.state.stateVersion) return o
      return n
    },
  })
}

export function useSessions() {
  return useQuery({ queryKey: ['sessions'], queryFn: () => server.staff.listSessions(), refetchInterval: 3000 })
}

// ───────────────────────── operator lease ─────────────────────────
const leaseKey = (sid: string, uid: string) => `gl-lease:${sid}:${uid}`

export function useOperatorLease(sessionId: string | null, user: User, serverLease: OperatorLease | null | undefined) {
  const [token, setToken] = useState<string | null>(() => {
    if (!sessionId) return null
    try {
      return sessionStorage.getItem(leaseKey(sessionId, user.id))
    } catch {
      return null
    }
  })
  const [lost, setLost] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!sessionId) return setToken(null)
    try {
      setToken(sessionStorage.getItem(leaseKey(sessionId, user.id)))
    } catch {
      setToken(null)
    }
    setLost(false)
  }, [sessionId, user.id])

  const store = useCallback(
    (t: string | null) => {
      if (!sessionId) return
      try {
        if (t) sessionStorage.setItem(leaseKey(sessionId, user.id), t)
        else sessionStorage.removeItem(leaseKey(sessionId, user.id))
      } catch {
        /* ignore */
      }
      setToken(t)
    },
    [sessionId, user.id],
  )

  // Renew every 5 s while we hold a token (worker-driven so background tabs keep renewing),
  // and immediately whenever this tab becomes visible again.
  const renewing = useRef(false)
  useEffect(() => {
    if (!sessionId || !token) return
    const renew = async () => {
      if (renewing.current) return
      renewing.current = true
      try {
        await server.staff.renewLease(sessionId, token, user)
      } catch (e) {
        if (e instanceof ApiError && e.code === 'LEASE_EXPIRED') {
          // Our own lease lapsed (e.g. laptop slept). If nobody else took control,
          // silently re-acquire — it is the same operator. Recorded as OPERATOR_ACQUIRED.
          try {
            const l = await server.staff.acquireLease(sessionId, user)
            store(l.leaseToken)
          } catch {
            store(null)
            setLost(true)
          }
        }
        // Network errors: keep the token and keep trying.
      } finally {
        renewing.current = false
      }
    }
    const stop = setWorkerInterval(() => void renew(), 5000)
    const onVis = () => document.visibilityState === 'visible' && void renew()
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', onVis)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', onVis)
    }
  }, [sessionId, token, user, store])

  const hasControl = !!token && !!serverLease && serverLease.leaseToken === token

  // Server says someone else holds it → we lost it.
  useEffect(() => {
    if (token && serverLease && serverLease.leaseToken !== token) {
      store(null)
      setLost(true)
    }
  }, [token, serverLease, store])

  const acquire = async () => {
    if (!sessionId) return
    setError(null)
    try {
      const l = await server.staff.acquireLease(sessionId, user)
      store(l.leaseToken)
      setLost(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const release = async () => {
    if (!sessionId || !token) return
    try {
      await server.staff.releaseLease(sessionId, token, user)
    } finally {
      store(null)
    }
  }
  const takeover = async (reason: string) => {
    if (!sessionId) return
    setError(null)
    try {
      const l = await server.staff.takeoverLease(sessionId, user, reason)
      store(l.leaseToken)
      setLost(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      throw e
    }
  }
  return { token, hasControl, lost, error, acquire, release, takeover, dismissLost: () => setLost(false) }
}

// ───────────────────────── commands with idempotency + lost-response recovery ─────────────────────────
export type CommandPhase = 'idle' | 'pending' | 'confirming'

export function useCommandRunner(sessionId: string | null, user: User, leaseToken: string | null) {
  const qc = useQueryClient()
  const [phase, setPhase] = useState<CommandPhase>('idle')
  const [error, setError] = useState<ApiError | null>(null)
  const inflight = useRef(false)

  const run = useCallback(
    async (cmd: Command, expectedVersion: number): Promise<ExecuteResponse | null> => {
      if (!sessionId || inflight.current) return null // duplicate-submission guard
      inflight.current = true
      setPhase('pending')
      setError(null)
      const key = uuid()
      const opts = { idempotencyKey: key, expectedVersion, leaseToken, user }
      // Apply the authoritative state from the response immediately, so the next
      // command is sent with the correct expected_version (no stale-cache conflicts).
      const applyResponse = (r: ExecuteResponse) =>
        qc.setQueryData<StaffView>(['staff', sessionId], (prev) => {
          if (!prev || prev.state.stateVersion > r.state.stateVersion) return prev
          const bids = r.bid && !prev.bids.some((b) => b.id === r.bid!.id) ? [r.bid, ...prev.bids] : prev.bids
          return { ...prev, state: r.state, bids }
        })
      try {
        let attempt = 0
        for (;;) {
          try {
            const r = await server.staff.execute(sessionId, cmd, opts)
            applyResponse(r)
            return r
          } catch (e) {
            if (!(e instanceof ApiError)) throw e
            if (e.code !== 'RESPONSE_LOST' && e.code !== 'NETWORK_ERROR') throw e
            // Response lost or network failed: never blindly resend — ask first.
            setPhase('confirming')
            attempt++
            await new Promise((r) => setTimeout(r, Math.min(500 * attempt, 3000)))
            try {
              const st = await server.staff.getIdempotency(key)
              if (st.status === 'COMPLETED' && st.response) {
                applyResponse(st.response)
                return st.response
              }
              // UNKNOWN → safe to resend with the SAME key; FAILED → resend replays the stored error.
            } catch {
              /* still offline; loop */
            }
            if (attempt > 20) throw new ApiError('NETWORK_ERROR', 'Could not confirm the action. Check the bid history.', 0)
          }
        }
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError('VALIDATION_FAILED', String(e))
        setError(err)
        return null
      } finally {
        inflight.current = false
        setPhase('idle')
        void qc.invalidateQueries({ queryKey: ['staff', sessionId] })
      }
    },
    [sessionId, user, leaseToken, qc],
  )

  return { run, phase, error, clearError: () => setError(null) }
}
