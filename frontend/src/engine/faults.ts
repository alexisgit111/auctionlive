/**
 * Fault injection for Phase 1A testing. Shared across tabs via storage so the
 * console's test panel can also break the display's "network".
 */
import type { KV } from './storage'

export interface Faults {
  /** Staff laptop cannot reach the cloud */
  consoleOffline: boolean
  /** Room display cannot reach the cloud */
  displayOffline: boolean
  /** Outbox relay fails to broadcast (DB commit still succeeds) */
  relayDown: boolean
  /** Probability 0..1 that a state broadcast is lost in transit */
  dropRate: number
  /** Extra delivery delay for broadcasts, ms */
  delayMs: number
  /** Deliver every broadcast twice */
  duplicate: boolean
  /** Hold each broadcast and deliver it after the next one */
  reorder: boolean
  /** The next staff mutation commits but its HTTP response is lost */
  loseNextResponse: boolean
  /** Simulated API latency, ms */
  latencyMs: number
}

export const DEFAULT_FAULTS: Faults = {
  consoleOffline: false,
  displayOffline: false,
  relayDown: false,
  dropRate: 0,
  delayMs: 0,
  duplicate: false,
  reorder: false,
  loseNextResponse: false,
  latencyMs: 120,
}

const KEY = 'gl-auction-faults-v1'

export function readFaults(kv: KV): Faults {
  try {
    const raw = kv.get(KEY)
    return raw ? { ...DEFAULT_FAULTS, ...JSON.parse(raw) } : { ...DEFAULT_FAULTS }
  } catch {
    return { ...DEFAULT_FAULTS }
  }
}

export function writeFaults(kv: KV, f: Partial<Faults>) {
  kv.set(KEY, JSON.stringify({ ...readFaults(kv), ...f }))
}

export const anyFaultActive = (f: Faults) =>
  f.consoleOffline ||
  f.displayOffline ||
  f.relayDown ||
  f.dropRate > 0 ||
  f.delayMs > 0 ||
  f.duplicate ||
  f.reorder ||
  f.loseNextResponse
