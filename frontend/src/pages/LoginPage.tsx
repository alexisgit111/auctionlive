import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { DEMO_LOGIN_HINT, server } from '../app/server'
import { useAuth } from '../app/user'
import { BrandLogo } from '../components/brand'
import { ErrorNote } from '../components/ui'

export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="panel w-full max-w-md overflow-hidden !rounded-[28px] !bg-white/75">
        <div className="p-8">
          <BrandLogo className="h-10" />
          <div className="mt-2 text-xs font-bold uppercase tracking-[0.22em] text-brand">Auction Live</div>
          <h1 className="mt-6 text-2xl font-bold text-navy">{title}</h1>
          {subtitle && <p className="mt-1 text-ink-muted">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </div>
  )
}

export function LoginPage() {
  const { user, login } = useAuth()
  const [params] = useSearchParams()
  const nav = useNavigate()
  const [email, setEmail] = useState(DEMO_LOGIN_HINT?.email ?? '')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [needsSetup, setNeedsSetup] = useState(false)
  const next = params.get('next') || '/auction/control'

  useEffect(() => {
    server.auth
      .setupStatus()
      .then((s) => setNeedsSetup(s.needsAdmin))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [])

  if (user) return <Navigate to={next} replace />
  if (needsSetup) return <Navigate to="/auction/setup" replace />

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setErr(null)
    setBusy(true)
    try {
      await login(email, password)
      nav(next, { replace: true })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthCard title="Staff sign in" subtitle="Internal use — Harcourts Golden Links staff only.">
      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="label">Email</span>
          <input className="field text-lg" type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="block">
          <span className="label">Password</span>
          <input
            className="field text-lg"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {err && <ErrorNote>{err}</ErrorNote>}
        <button className="btn-primary w-full py-3 text-lg" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      {DEMO_LOGIN_HINT && (
        <div className="mt-6 rounded-2xl bg-warn/10 p-3 text-sm text-ink">
          <b>Prototype mode.</b> Demo accounts (password <code>{DEMO_LOGIN_HINT.password}</code>):
          <ul className="mt-1 list-inside list-disc">
            {DEMO_LOGIN_HINT.users.map((u) => (
              <li key={u.id}>
                <button type="button" className="underline" onClick={() => setEmail(u.email ?? '')}>
                  {u.email}
                </button>{' '}
                — {u.role}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-6 text-center text-sm text-ink-faint">Forgot your password? Ask an Auction Live admin to reset it.</p>
    </AuthCard>
  )
}

export function SetupPage() {
  const { refresh } = useAuth()
  const nav = useNavigate()
  const [form, setForm] = useState({ setupKey: '', name: '', email: '', password: '', confirm: '' })
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [allowed, setAllowed] = useState<boolean | null>(null)

  useEffect(() => {
    server.auth
      .setupStatus()
      .then((s) => setAllowed(s.needsAdmin))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [])

  if (allowed === false) return <Navigate to="/auction/login" replace />

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value })
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setErr(null)
    if (form.password !== form.confirm) return setErr('Passwords do not match')
    setBusy(true)
    try {
      await server.auth.setupAdmin({ setupKey: form.setupKey, name: form.name, email: form.email, password: form.password })
      await server.auth.login(form.email, form.password)
      await refresh()
      nav('/auction/sessions', { replace: true })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthCard title="First-time setup" subtitle="Create the first admin account. This page disappears once an admin exists.">
      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="label">Setup key (from the server config file)</span>
          <input className="field" type="password" value={form.setupKey} onChange={set('setupKey')} required />
        </label>
        <label className="block">
          <span className="label">Your name</span>
          <input className="field" value={form.name} onChange={set('name')} required />
        </label>
        <label className="block">
          <span className="label">Email</span>
          <input className="field" type="email" autoComplete="username" value={form.email} onChange={set('email')} required />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="label">Password (8+ characters)</span>
            <input className="field" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} required minLength={8} />
          </label>
          <label className="block">
            <span className="label">Confirm</span>
            <input className="field" type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} required />
          </label>
        </div>
        {err && <ErrorNote>{err}</ErrorNote>}
        <button className="btn-primary w-full py-3 text-lg" disabled={busy || allowed === null}>
          {busy ? 'Creating…' : 'Create admin account'}
        </button>
      </form>
    </AuthCard>
  )
}
