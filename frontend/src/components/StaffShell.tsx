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
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-white px-3 md:h-20 md:gap-10 md:px-6">
        <div className="hidden sm:block">
          <Wordmark />
        </div>
        <nav className="flex h-full min-w-0 gap-1 overflow-x-auto" aria-label="Main">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              className={({ isActive }) =>
                `flex shrink-0 items-center border-b-[3px] px-2 text-base font-semibold md:px-4 md:text-lg ${
                  isActive ? 'border-brand text-navy' : 'border-transparent text-ink-muted hover:text-navy'
                }`
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-4">
          {BACKEND === 'mock' && (
            <span className="hidden rounded bg-warn/10 px-2.5 py-1 text-xs font-bold uppercase tracking-widest text-warn lg:inline">Prototype · local data</span>
          )}
          <div className="relative">
            <button
              className="flex items-center gap-3 rounded-lg border border-line px-1.5 py-1 text-left hover:bg-subtle md:px-3 md:py-1.5"
              onClick={() => setMenu((m) => !m)}
              aria-expanded={menu}
              data-testid="user-menu"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-navy text-sm font-bold text-white">
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
              <div className="absolute right-0 z-40 mt-2 w-48 overflow-hidden rounded-lg border border-line bg-white shadow-lg">
                {BACKEND === 'http' && (
                  <NavLink to="/auction/account" className="block px-4 py-2.5 text-sm font-semibold text-navy hover:bg-subtle" onClick={() => setMenu(false)}>
                    Change password
                  </NavLink>
                )}
                <button className="block w-full px-4 py-2.5 text-left text-sm font-semibold text-bad hover:bg-subtle" onClick={() => void logout()}>
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      <div className="h-1 bg-navy" aria-hidden />
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  )
}
