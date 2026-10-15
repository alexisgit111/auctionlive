/** Key/value store + cross-tab lock — the Phase 1A "database". */
export interface KV {
  get(key: string): string | null
  set(key: string, value: string): void
}

export type LockFn = <T>(name: string, fn: () => Promise<T> | T) => Promise<T>

export const browserKV: KV = {
  get: (k) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v)
    } catch (e) {
      console.error('[auction] storage write failed', e)
      throw e
    }
  },
}

export function memoryKV(): KV {
  const m = new Map<string, string>()
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) }
}

/** Promise-chain mutex; used when Web Locks are unavailable (tests). */
export function createLocalLock(): LockFn {
  const chains = new Map<string, Promise<unknown>>()
  return async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
    const prev = chains.get(name) ?? Promise.resolve()
    let release!: () => void
    const p = new Promise<void>((r) => (release = r))
    chains.set(name, prev.then(() => p))
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

/** Web Locks give a real cross-tab mutex — our stand-in for SELECT … FOR UPDATE. */
export function createBrowserLock(): LockFn {
  const local = createLocalLock()
  if (typeof navigator === 'undefined' || !('locks' in navigator)) return local
  return <T>(name: string, fn: () => Promise<T> | T) =>
    navigator.locks.request(name, async () => await fn()) as Promise<T>
}
