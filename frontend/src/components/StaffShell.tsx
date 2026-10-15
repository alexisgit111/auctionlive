import { NavLink, Outlet } from 'react-router-dom'
import { useUser } from '../app/user'
import { DEMO_USERS } from '../engine/mockServer'
import { Wordmark } from './brand'

const links = [
  { to: '/auction/control', label: 'Console' },
  { to: '/auction/sessions', label: 'Sessions' },
  { to: '/auction/reports', label: 'Reports' },
]

export function StaffShell() {
  const { user, setUser } = useUser()
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex h-20 shrink-0 items-center gap-10 border-b border-line bg-white px-6">
        <Wordmark />
        <nav className="flex h-full gap-1" aria-label="Main">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              className={({ isActive }) =>
                `flex items-center border-b-[3px] px-4 text-lg font-semibold ${
                  isActive ? 'border-brand text-navy' : 'border-transparent text-ink-muted hover:text-navy'
                }`
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <span className="rounded bg-warn/10 px-2.5 py-1 text-xs font-bold uppercase tracking-widest text-warn">Prototype · local data</span>
          <label className="flex items-center gap-2 text-sm text-ink-muted">
            <span>Signed in as</span>
            <select
              className="rounded-lg border border-line bg-white px-3 py-2 text-base font-semibold text-navy"
              value={user.id}
              onChange={(e) => setUser(DEMO_USERS.find((u) => u.id === e.target.value)!)}
            >
              {DEMO_USERS.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.role})
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>
      <div className="h-1 bg-navy" aria-hidden />
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  )
}
