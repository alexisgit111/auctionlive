import { createContext, useContext, useState, type ReactNode } from 'react'
import { DEMO_USERS } from '../engine/mockServer'
import type { User } from '../engine/types'

/**
 * Phase 1A identity: pick a demo user per browser tab (sessionStorage), so two
 * windows can act as two different staff members. Phase 1B → Sanctum login.
 */
const KEY = 'gl-auction-user'

function initial(): User {
  try {
    const id = sessionStorage.getItem(KEY)
    const u = DEMO_USERS.find((x) => x.id === id)
    if (u) return u
  } catch {
    /* ignore */
  }
  return DEMO_USERS.find((u) => u.role === 'admin')!
}

const Ctx = createContext<{ user: User; setUser: (u: User) => void } | null>(null)

export function UserProvider({ children }: { children: ReactNode }) {
  const [user, set] = useState<User>(initial)
  const setUser = (u: User) => {
    try {
      sessionStorage.setItem(KEY, u.id)
    } catch {
      /* ignore */
    }
    set(u)
  }
  return <Ctx.Provider value={{ user, setUser }}>{children}</Ctx.Provider>
}

export function useUser() {
  const c = useContext(Ctx)
  if (!c) throw new Error('UserProvider missing')
  return c
}
