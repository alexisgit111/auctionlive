/**
 * Phase 1A stand-in for WebSocket broadcasting. BroadcastChannel delivers to
 * other tabs/windows of the same origin (our "other computers"); local
 * listeners in the same tab are notified too.
 * Phase 1C replaces this with Laravel Echo on Reverb/Pusher behind the same interface.
 */
import type { PublicDisplayState } from './types'

export type BusMessage =
  | { type: 'state.updated'; sessionId: string; version: number; payload: PublicDisplayState }
  | { type: 'staff.changed'; sessionId: string }
  | { type: 'display.resync'; sessionId: string }
  | { type: 'device.revoked'; deviceId: string }
  | { type: 'device.moved'; deviceId: string }
  | { type: 'faults.changed' }

export interface Bus {
  publish(msg: BusMessage): void
  subscribe(fn: (msg: BusMessage) => void): () => void
}

export function createBroadcastBus(name = 'gl-auction'): Bus {
  const listeners = new Set<(m: BusMessage) => void>()
  const ch = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(name) : null
  ch?.addEventListener('message', (e: MessageEvent<BusMessage>) => listeners.forEach((l) => l(e.data)))
  return {
    publish(msg) {
      ch?.postMessage(msg)
      queueMicrotask(() => listeners.forEach((l) => l(msg)))
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

/** In-memory bus for tests. */
export function createMemoryBus(): Bus & { sent: BusMessage[] } {
  const listeners = new Set<(m: BusMessage) => void>()
  const sent: BusMessage[] = []
  return {
    sent,
    publish(msg) {
      sent.push(msg)
      listeners.forEach((l) => l(msg))
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
