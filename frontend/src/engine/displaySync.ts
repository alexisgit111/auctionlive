/**
 * Display-side version tracking (REALTIME.md §4). Pure so it can be unit tested
 * against delayed, duplicated, dropped and out-of-order deliveries.
 */
import type { PublicDisplayState } from './types'

export interface SyncState {
  applied: PublicDisplayState | null
  appliedVersion: number
}

export type SyncInput = { kind: 'snapshot'; state: PublicDisplayState } | { kind: 'message'; state: PublicDisplayState }

export type SyncOutcome = 'applied' | 'ignored-stale' | 'gap'

export const initialSync: SyncState = { applied: null, appliedVersion: -1 }

export function reduceSync(s: SyncState, input: SyncInput): { next: SyncState; outcome: SyncOutcome } {
  const v = input.state.stateVersion
  // The screen was moved to another session: versions restart there, so take its snapshot as-is.
  if (s.applied && input.state.sessionId !== s.applied.sessionId) {
    if (input.kind !== 'snapshot') return { next: s, outcome: 'gap' }
    return { next: { applied: input.state, appliedVersion: v }, outcome: 'applied' }
  }
  if (input.kind === 'snapshot') {
    // A snapshot is authoritative unless a newer version is already on screen (late response).
    if (v < s.appliedVersion) return { next: s, outcome: 'ignored-stale' }
    return { next: { applied: input.state, appliedVersion: v }, outcome: 'applied' }
  }
  if (v <= s.appliedVersion) return { next: s, outcome: 'ignored-stale' }
  if (s.appliedVersion >= 0 && v > s.appliedVersion + 1) return { next: s, outcome: 'gap' }
  // First message before any snapshot: treat as gap so we always start from a snapshot.
  if (s.appliedVersion < 0) return { next: s, outcome: 'gap' }
  return { next: { applied: input.state, appliedVersion: v }, outcome: 'applied' }
}
