/**
 * Phase 1A wiring: one mock authoritative server shared through localStorage.
 * Phase 1B/1C: replace with HTTP + Echo transports exposing the same surface.
 */
import { createBroadcastBus } from '../engine/bus'
import { createMockServer } from '../engine/mockServer'
import { browserKV, createBrowserLock } from '../engine/storage'
import { putImage } from '../lib/imageStore'

export const bus = createBroadcastBus()
export const server = createMockServer({ kv: browserKV, lock: createBrowserLock(), bus })
export const kv = browserKV

// Upgrade older local data that stored photos inline (caused storage-quota errors).
if (typeof window !== 'undefined') {
  void server.migrateInlineImages(putImage).catch((e) => console.error('[auction] image migration failed', e))
}

// Cross-tab nudge when another tab edits faults/db (storage events fire in *other* tabs).
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'gl-auction-faults-v1') bus.publish({ type: 'faults.changed' })
  })
}
