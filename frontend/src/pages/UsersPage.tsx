import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { server } from '../app/server'
import { useUser } from '../app/user'
import { ErrorNote, Modal } from '../components/ui'
import type { ManagedUser } from '../engine/api'

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Admin: manage staff accounts. */
export function UsersPage() {
  const { user } = useUser()
  const qc = useQueryClient()
  const users = useQuery({ queryKey: ['users'], queryFn: () => server.auth.listUsers() })
  const [adding, setAdding] = useState(false)
  const [resetFor, setResetFor] = useState<ManagedUser | null>(null)
  const [err, setErr] = useState<string | null>(null)

  if (user.role !== 'admin') return <Navigate to="/auction/control" replace />

  const update = async (id: string, patch: Parameters<typeof server.auth.updateUser>[1]) => {
    setErr(null)
    try {
      await server.auth.updateUser(id, patch)
      await qc.invalidateQueries({ queryKey: ['users'] })
    } catch (e) {
      setErr(errText(e))
    }
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-navy">Staff accounts</h1>
          <p className="text-sm text-ink-muted">
            <b>Admin</b>: sessions, pairing displays, staff accounts, control takeover. <b>Operator</b>: run the console on auction day.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setAdding(true)}>
          Add staff member
        </button>
      </div>
      {err && <div className="mb-4"><ErrorNote onDismiss={() => setErr(null)}>{err}</ErrorNote></div>}
      {users.isError && <ErrorNote>{errText(users.error)}</ErrorNote>}
      <div className="panel overflow-hidden">
        <table className="w-full">
          <thead className="bg-subtle text-left text-xs uppercase tracking-widest text-ink-faint">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {users.data?.map((u) => (
              <tr key={u.id} className={`border-t border-line ${u.active === false ? 'opacity-50' : ''}`}>
                <td className="px-4 py-3 font-semibold text-navy">
                  {u.name} {u.id === user.id && <span className="ml-1 text-xs text-ink-faint">(you)</span>}
                </td>
                <td className="px-4 py-3 text-ink-muted">{u.email}</td>
                <td className="px-4 py-3">
                  <select
                    className="rounded-md border border-line bg-white px-2 py-1 font-semibold text-navy"
                    value={u.role}
                    disabled={u.id === user.id}
                    onChange={(e) => void update(u.id, { role: e.target.value as 'admin' | 'operator' })}
                  >
                    <option value="operator">Operator</option>
                    <option value="admin">Admin</option>
                  </select>
                </td>
                <td className="px-4 py-3">
                  {u.active === false ? <span className="font-semibold text-bad">Disabled</span> : <span className="font-semibold text-ok">Active</span>}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-2">
                    <button className="btn-ghost px-3 py-1 text-sm" onClick={() => setResetFor(u)}>
                      Reset password
                    </button>
                    {u.id !== user.id && (
                      <button className="btn-ghost px-3 py-1 text-sm" onClick={() => void update(u.id, { active: u.active === false })}>
                        {u.active === false ? 'Enable' : 'Disable'}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {adding && (
        <AddUserDialog
          onClose={() => setAdding(false)}
          onCreated={async () => {
            setAdding(false)
            await qc.invalidateQueries({ queryKey: ['users'] })
          }}
        />
      )}
      {resetFor && <ResetPasswordDialog user={resetFor} onClose={() => setResetFor(null)} />}
    </div>
  )
}

function AddUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [f, setF] = useState({ name: '', email: '', role: 'operator' as 'operator' | 'admin', password: '' })
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      await server.auth.createUser(f)
      onCreated()
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title="Add staff member" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="label">Name</span>
          <input className="field" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        </label>
        <label className="block">
          <span className="label">Email (used to sign in)</span>
          <input className="field" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
        </label>
        <label className="block">
          <span className="label">Role</span>
          <select className="field" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as 'operator' | 'admin' })}>
            <option value="operator">Operator — runs the console</option>
            <option value="admin">Admin — full access</option>
          </select>
        </label>
        <label className="block">
          <span className="label">Temporary password (8+ characters)</span>
          <input className="field" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={8} />
        </label>
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={busy}>
            Create account
          </button>
        </div>
      </form>
    </Modal>
  )
}

function ResetPasswordDialog({ user, onClose }: { user: ManagedUser; onClose: () => void }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await server.auth.updateUser(user.id, { password: pw })
      setDone(true)
    } catch (e) {
      setErr(errText(e))
    }
  }
  return (
    <Modal title={`Reset password — ${user.name}`} onClose={onClose}>
      {done ? (
        <>
          <p className="mb-4 text-ink">Password updated. Give the new password to {user.name} in person.</p>
          <div className="flex justify-end">
            <button className="btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <label className="block">
            <span className="label">New password (8+ characters)</span>
            <input className="field" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={8} autoFocus />
          </label>
          {err && <ErrorNote>{err}</ErrorNote>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn-primary">Set password</button>
          </div>
        </form>
      )}
    </Modal>
  )
}

export function AccountPage() {
  const { user } = useUser()
  const [f, setF] = useState({ current: '', next: '', confirm: '' })
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (f.next !== f.confirm) return setMsg({ ok: false, text: 'New passwords do not match' })
    try {
      await server.auth.changePassword(f.current, f.next)
      setF({ current: '', next: '', confirm: '' })
      setMsg({ ok: true, text: 'Password changed.' })
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
    }
  }
  return (
    <div className="mx-auto max-w-md p-6">
      <h1 className="mb-1 text-2xl font-bold text-navy">Change password</h1>
      <p className="mb-5 text-ink-muted">{user.email}</p>
      <form onSubmit={submit} className="panel space-y-3 p-5">
        <label className="block">
          <span className="label">Current password</span>
          <input className="field" type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} required />
        </label>
        <label className="block">
          <span className="label">New password (8+ characters)</span>
          <input className="field" type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} required minLength={8} />
        </label>
        <label className="block">
          <span className="label">Confirm new password</span>
          <input className="field" type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} required />
        </label>
        {msg && <p className={msg.ok ? 'text-ok' : 'text-bad'}>{msg.text}</p>}
        <button className="btn-primary w-full">Change password</button>
      </form>
    </div>
  )
}
