import { useQueryClient } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { User } from '../engine/types'
import { server } from './server'

/**
 * Signed-in staff member. In http mode the PHP session cookie is the source of truth;
 * in mock mode a demo user is kept per browser tab.
 */
interface AuthState {
  user: User | null
  loading: boolean
  error: string | null
  login: (email: string, password: string) => Promise<User>
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

const Ctx = createContext<AuthState | null>(null)

export function UserProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setUser(await server.auth.me())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => void refresh(), [refresh])

  const login = async (email: string, password: string) => {
    const u = await server.auth.login(email, password)
    qc.clear()
    setUser(u)
    return u
  }
  const logout = async () => {
    try {
      await server.auth.logout()
    } finally {
      qc.clear()
      setUser(null)
    }
  }

  return <Ctx.Provider value={{ user, loading, error, login, logout, refresh }}>{children}</Ctx.Provider>
}

export function useAuth(): AuthState {
  const c = useContext(Ctx)
  if (!c) throw new Error('UserProvider missing')
  return c
}

/** For pages inside the signed-in staff area (StaffShell guarantees a user). */
export function useUser(): { user: User } {
  const { user } = useAuth()
  if (!user) throw new Error('useUser() used outside the signed-in area')
  return { user }
}
