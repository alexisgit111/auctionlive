import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useSessions } from '../app/hooks'
import { server } from '../app/server'
import { useUser } from '../app/user'
import { PersonPhoto, PropertyImage } from '../components/brand'
import { putImage } from '../lib/imageStore'
import { ErrorNote } from '../components/ui'
import type { SessionInput } from '../engine/mockServer'
import { MAX_SALESPEOPLE, type Salesperson, type Session } from '../engine/types'
import { formatCents, formatCompact, parseBidInput } from '../lib/money'

const blank = (): FormState => ({
  title: '',
  scheduledAt: new Date(Date.now() + 86400000).toISOString().slice(0, 16),
  auctioneerName: '',
  salespeople: [],
  increment: '10K',
  reserve: '',
  internalNotes: '',
  addressLine: '',
  suburb: '',
  city: 'Auckland',
  heroImage: null,
  bedrooms: '',
  bathrooms: '',
  parking: '',
  landAreaM2: '',
  floorAreaM2: '',
  badge: '',
})

interface FormState {
  title: string
  scheduledAt: string
  auctioneerName: string
  salespeople: Salesperson[]
  increment: string
  reserve: string
  internalNotes: string
  addressLine: string
  suburb: string
  city: string
  heroImage: string | null
  bedrooms: string
  bathrooms: string
  parking: string
  landAreaM2: string
  floorAreaM2: string
  badge: string
}

const numOrNull = (v: string): number | null => {
  const t = v.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null
}
const str = (n: number | null | undefined) => (n == null ? '' : String(n))

const fromSession = (s: Session): FormState => ({
  title: s.title,
  scheduledAt: s.scheduledAt.slice(0, 16),
  auctioneerName: s.auctioneerName,
  salespeople: (s.salespeople ?? []).map((p) => ({ ...p })),
  increment: formatCompact(s.defaultIncrementCents),
  reserve: s.reserveCents ? formatCompact(s.reserveCents) : '',
  internalNotes: s.internalNotes,
  addressLine: s.property.addressLine,
  suburb: s.property.suburb,
  city: s.property.city,
  heroImage: s.property.heroImage,
  bedrooms: str(s.property.bedrooms),
  bathrooms: str(s.property.bathrooms),
  parking: str(s.property.parking),
  landAreaM2: str(s.property.landAreaM2),
  floorAreaM2: str(s.property.floorAreaM2),
  badge: s.property.badge ?? '',
})

/** Downscale an uploaded photo so it fits comfortably in local storage. */
async function resizeImage(file: File, maxW = 1600): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image()
      i.onload = () => res(i)
      i.onerror = rej
      i.src = url
    })
    const scale = Math.min(1, maxW / img.width)
    const c = document.createElement('canvas')
    c.width = Math.round(img.width * scale)
    c.height = Math.round(img.height * scale)
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
    return c.toDataURL('image/jpeg', 0.82)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function SessionsPage() {
  const { user } = useUser()
  const qc = useQueryClient()
  const sessions = useSessions()
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [form, setForm] = useState<FormState>(blank)
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)

  useEffect(() => void server.ensureSeed().then(() => qc.invalidateQueries({ queryKey: ['sessions'] })), [qc])

  const isAdmin = user.role === 'admin'
  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value })

  const save = async () => {
    setErr(null)
    const inc = parseBidInput(form.increment)
    if (!inc.ok) return setErr(`Increment: ${inc.message}`)
    let reserveCents: string | null = null
    if (form.reserve.trim()) {
      const r = parseBidInput(form.reserve)
      if (!r.ok) return setErr(`Reserve: ${r.message}`)
      reserveCents = r.cents.toString()
    }
    const input: SessionInput = {
      title: form.title || `${form.addressLine}`,
      scheduledAt: new Date(form.scheduledAt).toISOString(),
      auctioneerName: form.auctioneerName,
      salespeople: form.salespeople.filter((p) => p.name.trim()).map((p) => ({ name: p.name.trim(), photo: p.photo })),
      defaultIncrementCents: inc.cents.toString(),
      reserveCents,
      internalNotes: form.internalNotes,
      property: {
        addressLine: form.addressLine,
        suburb: form.suburb,
        city: form.city,
        heroImage: form.heroImage,
        bedrooms: numOrNull(form.bedrooms),
        bathrooms: numOrNull(form.bathrooms),
        parking: numOrNull(form.parking),
        landAreaM2: numOrNull(form.landAreaM2),
        floorAreaM2: numOrNull(form.floorAreaM2),
        badge: form.badge.trim(),
      },
    }
    setSaving(true)
    try {
      if (editing === 'new') await server.staff.createSession(input, user)
      else if (editing) await server.staff.updateSession(editing, input, user)
      setEditing(null)
      await qc.invalidateQueries({ queryKey: ['sessions'] })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-navy">Auction sessions</h1>
          <p className="text-sm text-ink-muted">Set up the property, increment and private reserve before auction day.</p>
        </div>
        {server.mode === 'mock' && (<button
          className={`ml-auto mr-2 text-sm ${confirmReset ? 'btn-danger' : 'btn-ghost'}`}
          disabled={!isAdmin}
          onClick={() => {
            if (!confirmReset) return setConfirmReset(true)
            server.resetAll()
            setConfirmReset(false)
            void server.ensureSeed().then(() => qc.invalidateQueries())
          }}
          onBlur={() => setConfirmReset(false)}
        >
          {confirmReset ? 'Click again to erase all local prototype data' : 'Reset prototype data'}
        </button>)}
        <button
          className="btn-primary"
          disabled={!isAdmin}
          title={isAdmin ? '' : 'Switch to the Admin user to create sessions'}
          onClick={() => {
            setForm(blank())
            setEditing('new')
          }}
        >
          New session
        </button>
      </div>

      {editing && (
        <div className="panel mb-6 p-5">
          <h2 className="mb-4 text-lg font-bold text-navy">{editing === 'new' ? 'New session' : 'Edit session'}</h2>
          <div className="grid grid-cols-12 gap-4">
            <div className="col-span-8 grid grid-cols-2 gap-4">
              <Field label="Property address" className="col-span-2">
                <input className="field" value={form.addressLine} onChange={set('addressLine')} placeholder="12 Example Road" />
              </Field>
              <Field label="Suburb">
                <input className="field" value={form.suburb} onChange={set('suburb')} />
              </Field>
              <Field label="City">
                <input className="field" value={form.city} onChange={set('city')} />
              </Field>
              <div className="col-span-2 grid grid-cols-5 gap-3">
                <Field label="Bedrooms">
                  <input className="field" inputMode="numeric" value={form.bedrooms} onChange={set('bedrooms')} />
                </Field>
                <Field label="Bathrooms">
                  <input className="field" inputMode="numeric" value={form.bathrooms} onChange={set('bathrooms')} />
                </Field>
                <Field label="Garage / parks">
                  <input className="field" inputMode="numeric" value={form.parking} onChange={set('parking')} />
                </Field>
                <Field label="Land m²">
                  <input className="field" inputMode="numeric" value={form.landAreaM2} onChange={set('landAreaM2')} />
                </Field>
                <Field label="Floor m²">
                  <input className="field" inputMode="numeric" value={form.floorAreaM2} onChange={set('floorAreaM2')} />
                </Field>
              </div>
              <Field label="Display badge (optional)" className="col-span-2">
                <input className="field" value={form.badge} onChange={set('badge')} placeholder="e.g. Brought Forward" maxLength={24} />
              </Field>
              <Field label="Session title (internal)">
                <input className="field" value={form.title} onChange={set('title')} placeholder="Defaults to address" />
              </Field>
              <Field label="Auction date & time">
                <input type="datetime-local" className="field" value={form.scheduledAt} onChange={set('scheduledAt')} />
              </Field>
              <Field label="Auctioneer (internal record)">
                <input className="field" value={form.auctioneerName} onChange={set('auctioneerName')} placeholder="e.g. John Doe" />
              </Field>
              <div className="col-span-2 rounded-md border border-line bg-subtle p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="label mb-0">Salespeople shown on room display (max {MAX_SALESPEOPLE})</span>
                  {form.salespeople.length < MAX_SALESPEOPLE && (
                    <button
                      className="btn-ghost bg-white px-3 py-1 text-sm"
                      onClick={() => setForm({ ...form, salespeople: [...form.salespeople, { name: '', photo: null }] })}
                    >
                      + Add salesperson
                    </button>
                  )}
                </div>
                {form.salespeople.length === 0 && <p className="text-sm text-ink-muted">None — the room display will not show a salesperson.</p>}
                <div className="space-y-2">
                  {form.salespeople.map((p, i) => {
                    const update = (patch: Partial<Salesperson>) =>
                      setForm({ ...form, salespeople: form.salespeople.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
                    return (
                      <div key={i} className="flex items-center gap-3">
                        <div className="h-14 w-14 shrink-0 overflow-hidden rounded-full border border-line bg-white">
                          <PersonPhoto src={p.photo} />
                        </div>
                        <input
                          className="field flex-1 bg-white"
                          value={p.name}
                          aria-label={`Salesperson ${i + 1} name`}
                          onChange={(e) => update({ name: e.target.value })}
                          placeholder={`Salesperson ${i + 1} name`}
                        />
                        <label className="btn-ghost cursor-pointer bg-white px-3 py-2 text-sm">
                          {p.photo ? 'Change photo…' : 'Upload photo…'}
                          <input
                            type="file"
                            accept="image/*"
                            className="sr-only"
                            onChange={async (e) => {
                              const f = e.target.files?.[0]
                              if (f) update({ photo: await putImage(await resizeImage(f, 600)) })
                            }}
                          />
                        </label>
                        <button
                          className="btn-ghost bg-white px-3 py-2 text-sm"
                          aria-label={`Remove salesperson ${i + 1}`}
                          onClick={() => setForm({ ...form, salespeople: form.salespeople.filter((_, j) => j !== i) })}
                        >
                          Remove
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
              <Field label="Default increment">
                <input className="field" value={form.increment} onChange={set('increment')} placeholder="10K" />
              </Field>
              <Field label="Reserve — private, never shown on display">
                <input className="field" value={form.reserve} onChange={set('reserve')} placeholder="e.g. 1.3M (optional)" />
              </Field>
              <Field label="Internal notes — private">
                <input className="field" value={form.internalNotes} onChange={set('internalNotes')} />
              </Field>
            </div>
            <div className="col-span-4">
              <span className="label">Property photo (shown on display)</span>
              <div className="aspect-[4/3] overflow-hidden rounded-md border border-line">
                <PropertyImage src={form.heroImage} alt="Property" />
              </div>
              <div className="mt-2 flex gap-2">
                <label className="btn-ghost cursor-pointer px-3 py-1 text-sm">
                  Upload…
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={async (e) => {
                      const f = e.target.files?.[0]
                      if (f) setForm({ ...form, heroImage: await putImage(await resizeImage(f)) })
                    }}
                  />
                </label>
                {form.heroImage && (
                  <button className="btn-ghost px-3 py-1 text-sm" onClick={() => setForm({ ...form, heroImage: null })}>
                    Remove
                  </button>
                )}
              </div>
            </div>
          </div>
          {err && <div className="mt-4"><ErrorNote>{err}</ErrorNote></div>}
          <div className="mt-5 flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button className="btn-primary" disabled={saving} onClick={save}>
              {saving ? 'Saving…' : 'Save session'}
            </button>
          </div>
        </div>
      )}

      {sessions.isError && <ErrorNote>Cannot load sessions: {String(sessions.error)}</ErrorNote>}
      <div className="grid gap-3">
        {sessions.data?.map(({ session: s, state }) => (
          <div key={s.id} className="panel flex items-center gap-4 p-3">
            <div className="h-16 w-24 shrink-0 overflow-hidden rounded">
              <PropertyImage src={s.property.heroImage} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-lg font-bold text-navy">
                {s.property.addressLine}, {s.property.suburb}
              </div>
              <div className="text-sm text-ink-muted">
                {new Date(s.scheduledAt).toLocaleString('en-NZ', { dateStyle: 'medium', timeStyle: 'short' })} · Increment{' '}
                {formatCents(s.defaultIncrementCents)} · {state.bidCount} bids · Current {formatCents(state.currentBidCents)}
              </div>
            </div>
            <span className="rounded bg-subtle px-2 py-1 text-xs font-bold uppercase tracking-wider text-ink-muted">
              {state.sessionStatus.replace('_', ' ')}
              {state.saleStatus !== 'NONE' && ` · ${state.saleStatus.replace(/_/g, ' ')}`}
            </span>
            <button
              className="btn-ghost px-3 py-1.5 text-sm"
              disabled={!isAdmin}
              onClick={() => {
                setForm(fromSession(s))
                setEditing(s.id)
              }}
            >
              Edit
            </button>
            <Link to={`/auction/control?session=${s.id}`} className="btn-primary px-3 py-1.5 text-sm">
              Open console
            </Link>
          </div>
        ))}
      </div>
    </div>
  )
}

function Field({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="label">{label}</span>
      {children}
    </label>
  )
}
