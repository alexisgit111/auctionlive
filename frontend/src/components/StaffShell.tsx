import { useState } from 'react'
import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useConsoleLayout } from '../app/layout'
import { BACKEND } from '../app/server'
import { useAuth } from '../app/user'
import { Wordmark } from './brand'

export function StaffShell() {
  const { user, loading, error, logout } = useAuth()
  const loc = useLocation()
  const [menu, setMenu] = useState(false)
  const layout = useConsoleLayout()

  if (loading)
    return <div className="flex min-h-full items-center justify-center text-lg text-ink-muted">Loading…</div>
  if (!user) {
    if (error)
      return (
        <div className="flex min-h-full flex-col items-center justify-center gap-3 p-8 text-center">
          <div className="text-xl font-bold text-navy">Cannot reach Auction Live</div>
          <div className="text-ink-muted">{error}</div>
          <button className="btn-primary" onClick={() => location.reload()}>
            Try again
          </button>
        </div>
      )
    return <Navigate to={`/auction/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />
  }

  const links = [
    { to: '/auction/control', label: 'Console' },
    { to: '/auction/sessions', label: 'Sessions' },
    { to: '/auction/reports', label: 'Reports' },
    ...(user.role === 'admin' ? [{ to: '/auction/media', label: 'Media' }] : []),
    ...(user.role === 'admin' && BACKEND === 'http' ? [{ to: '/auction/users', label: 'Users' }] : []),
  ]

  // The phone console is full screen and has its own menu.
  if (layout.mobile && loc.pathname.startsWith('/auction/control')) return <Outlet />

  return (
    <div className="flex min-h-full flex-col">
      <header className="glass-bar sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 px-3 md:h-[72px] md:gap-8 md:px-6">
        <div className="hidden sm:block">
          <Wordmark />
        </div>
        <nav className="flex min-w-0 gap-1 overflow-x-auto rounded-full p-1" aria-label="Main">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              className={({ isActive }) =>
                `flex shrink-0 items-center rounded-full px-3 py-1.5 text-base font-semibold transition-colors md:px-4 md:text-[17px] ${
                  isActive ? 'bg-brand text-white shadow-[0_4px_12px_-4px_rgba(0,161,233,0.7)]' : 'text-ink-muted hover:bg-white/80 hover:text-navy'
                }`
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-4">
          {BACKEND === 'mock' && (
            <span className="hidden rounded-full bg-warn/10 px-3 py-1 text-xs font-bold uppercase tracking-widest text-warn lg:inline">Prototype · local data</span>
          )}
          <div className="relative">
            <button
              className="btn-ghost gap-3 !rounded-full !px-1.5 !py-1 text-left md:!pr-4"
              onClick={() => setMenu((m) => !m)}
              aria-expanded={menu}
              data-testid="user-menu"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand text-sm font-bold text-white">
                {user.name
                  .split(/\s+/)
                  .map((p) => p[0])
                  .slice(0, 2)
                  .join('')
                  .toUpperCase()}
              </span>
              <span className="hidden leading-tight md:block">
                <span className="block text-base font-semibold text-navy">{user.name}</span>
                <span className="block text-xs font-bold uppercase tracking-wider text-ink-muted">{user.role}</span>
              </span>
            </button>
            {menu && (
              <div className="panel absolute right-0 z-40 mt-2 w-52 overflow-hidden !bg-white/90 p-1">
                {BACKEND === 'http' && (
                  <NavLink to="/auction/account" className="block rounded-xl px-4 py-2.5 text-sm font-semibold text-navy hover:bg-brand/10" onClick={() => setMenu(false)}>
                    Change password
                  </NavLink>
                )}
                <button className="block w-full rounded-xl px-4 py-2.5 text-left text-sm font-semibold text-bad hover:bg-bad/10" onClick={() => void logout()}>
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  )
}
