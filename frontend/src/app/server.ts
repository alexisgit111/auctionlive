/**
 * Chooses the backend at build time:
 *   VITE_BACKEND=http  → PHP + MySQL API (Cloudways). Shared data, real logins.
 *   otherwise          → in-browser mock (local development, prototype tests).
 */
import type { AppServer, AuthApi } from '../engine/api'
import { createBroadcastBus } from '../engine/bus'
import { createHttpServer } from '../engine/httpServer'
import { DEMO_USERS, createMockServer } from '../engine/mockServer'
import { browserKV, createBrowserLock } from '../engine/storage'
import { ApiError, type User } from '../engine/types'
import { putLocalImage, setImageUploader } from '../lib/imageStore'

export const bus = createBroadcastBus()
export const kv = browserKV

export const BACKEND: 'mock' | 'http' = import.meta.env.VITE_BACKEND === 'http' ? 'http' : 'mock'

function createMockApp(): AppServer {
  const mock = createMockServer({ kv: browserKV, lock: createBrowserLock(), bus })
  const USER_KEY = 'gl-auction-user'
  const DEMO_PASSWORD = 'demo1234'
  const readOnly = () => Promise.reject(new ApiError('FORBIDDEN', 'User management is not available in prototype mode', 403))
  const auth: AuthApi = {
    async me() {
      try {
        return DEMO_USERS.find((u) => u.id === sessionStorage.getItem(USER_KEY)) ?? null
      } catch {
        return null
      }
    },
    async login(email, password) {
      const u = DEMO_USERS.find((x) => x.email === email.trim().toLowerCase())
      if (!u || password !== DEMO_PASSWORD) throw new ApiError('UNAUTHENTICATED', 'Email or password is incorrect', 401)
      sessionStorage.setItem(USER_KEY, u.id)
      return u
    },
    async logout() {
      sessionStorage.removeItem(USER_KEY)
    },
    setupStatus: async () => ({ needsAdmin: false }),
    setupAdmin: readOnly,
    listUsers: async () => DEMO_USERS,
    createUser: readOnly,
    updateUser: readOnly,
    changePassword: readOnly,
  }
  // Upgrade older local data that stored photos inline.
  if (typeof window !== 'undefined') {
    void mock.migrateInlineImages(putLocalImage).catch((e) => console.error('[auction] image migration failed', e))
    window.addEventListener('storage', (e) => {
      if (e.key === 'gl-auction-faults-v1') bus.publish({ type: 'faults.changed' })
    })
  }
  return {
    mode: 'mock',
    staff: mock.staff,
    display: mock.display,
    auth,
    uploadImage: putLocalImage,
    ensureSeed: mock.ensureSeed,
    resetAll: mock.resetAll,
    displayPollMs: 2000,
  }
}

export const server: AppServer = BACKEND === 'http' ? createHttpServer(import.meta.env.VITE_API_BASE ?? '') : createMockApp()
setImageUploader(server.uploadImage)

export const DEMO_LOGIN_HINT: { email: string; password: string; users: User[] } | null =
  BACKEND === 'mock' ? { email: 'admin@demo.local', password: 'demo1234', users: DEMO_USERS } : null
