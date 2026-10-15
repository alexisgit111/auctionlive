import { useEffect, useRef, useState } from 'react'
import type { CloudStatus } from '../../app/hooks'
import { bus, kv, server } from '../../app/server'
import { useUser } from '../../app/user'
import { allowedCommands } from '../../engine/engine'
import { DEFAULT_FAULTS, writeFaults, type Faults } from '../../engine/faults'
import type { StaffView } from '../../engine/mockServer'
import { derivePublicStatus } from '../../engine/publicState'
import type { Bid, Command, Device, OperatorLease } from '../../engine/types'
import { formatCents, parseBidInput } from '../../lib/money'
import { downloadFile, type OfflineRecord } from '../../lib/offlineStore'
import { Chip, ErrorNote, Kbd, Modal } from '../ui'

const STATUS_LABEL: Record<string, string> = {
  NOT_STARTED: 'Not started',
  LIVE: 'Live',
  PAUSED: 'Paused',
  ENDED: 'Ended',
  NONE: '—',
  ON_THE_MARKET: 'On the market',
  SOLD: 'Sold',
  PASSED_IN: 'Passed in',
}

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-NZ', { hour12: false })

// ───────────────────────── device health ─────────────────────────
export function deviceHealth(d: Device, stateVersion: number, now: number) {
  const hb = d.lastHeartbeatAt ? Date.parse(d.lastHeartbeatAt) : 0
  const connected = !d.revokedAt && now - hb <= 5000
  const synced = d.lastAckedVersion === stateVersion
  return { connected, synced }
}

export function useDisplaysHealth(view: StaffView | undefined, now: number) {
  const since = useRef<number | null>(null)
  const devices = (view?.devices ?? []).filter((d) => !d.revokedAt)
  const healths = devices.map((d) => ({ d, ...deviceHealth(d, view!.state.stateVersion, now) }))
  const connected = healths.filter((h) => h.connected)
  const allSynced = connected.length > 0 && connected.every((h) => h.synced)
  if (allSynced || connected.length === 0) since.current = null
  else if (since.current === null) since.current = now
  const outOfSync = since.current !== null && now - since.current > 2000
  const applied = connected.length ? Math.min(...connected.map((h) => h.d.lastAckedVersion)) : null
  return { paired: devices.length, connected: connected.length, outOfSync, syncing: !allSynced && !outOfSync, applied, healths }
}

// ───────────────────────── health strip ─────────────────────────
export function HealthStrip({
  cloud,
  view,
  now,
  hasControl,
  lease,
  offlineCount,
}: {
  cloud: CloudStatus
  view: StaffView | undefined
  now: number
  hasControl: boolean
  lease: OperatorLease | null | undefined
  offlineCount: number
}) {
  const dh = useDisplaysHealth(view, now)
  const v = view?.state.stateVersion
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Chip label="Cloud" value={cloud === 'DEGRADED' ? 'Checking' : cloud} tone={cloud === 'ONLINE' ? 'ok' : cloud === 'DEGRADED' ? 'warn' : 'bad'} />
      <Chip
        label="Room display"
        value={dh.paired === 0 ? 'Not paired' : dh.connected > 0 ? 'Connected' : 'Disconnected'}
        tone={dh.paired === 0 ? 'warn' : dh.connected > 0 ? 'ok' : 'bad'}
      />
      <Chip
        label="State"
        value={dh.connected === 0 ? '—' : dh.outOfSync ? 'Out of sync' : dh.syncing ? 'Syncing' : 'Synced'}
        tone={dh.connected === 0 ? 'neutral' : dh.outOfSync ? 'bad' : dh.syncing ? 'warn' : 'ok'}
      />
      <Chip label="Applied version" value={dh.applied === null ? `— / v${v ?? '—'}` : `v${dh.applied} / v${v}`} tone="neutral" />
      <Chip
        label="Control"
        value={hasControl ? 'You' : lease ? lease.userName : 'None'}
        tone={hasControl ? 'ok' : lease ? 'warn' : 'bad'}
      />
      <Chip
        label="Offline scribing"
        value={cloud === 'OFFLINE' ? `Active · ${offlineCount}` : offlineCount ? `${offlineCount} pending` : 'Standby'}
        tone={cloud === 'OFFLINE' ? 'bad' : offlineCount ? 'warn' : 'neutral'}
      />
    </div>
  )
}

// ───────────────────────── current bid card ─────────────────────────
export function CurrentBidCard({ view }: { view: StaffView }) {
  const { state, bids, session } = view
  const active = bids.filter((b) => b.status === 'ACTIVE').sort((a, b) => b.seq - a.seq)
  const prev = active[1]
  const delta = state.currentBidCents && prev ? BigInt(state.currentBidCents) - BigInt(prev.amountCents) : null
  const pub = derivePublicStatus(state)
  const reserve = session.reserveCents ? BigInt(session.reserveCents) : null
  const cur = state.currentBidCents ? BigInt(state.currentBidCents) : null
  const flashRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = flashRef.current
    if (!el) return
    el.classList.remove('bid-flash')
    void el.offsetWidth
    el.classList.add('bid-flash')
  }, [state.currentBidId])

  return (
    <div ref={flashRef} className="panel relative overflow-hidden p-5">
      <div className="absolute inset-y-0 left-0 w-1.5 bg-brand" aria-hidden />
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="panel-title">Current accepted bid · on display</div>
          <div className="mt-1 text-[64px] font-bold leading-none tracking-tight text-navy" data-testid="current-bid">
            {state.currentBidCents ? formatCents(state.currentBidCents) : 'No bids yet'}
          </div>
          <div className="mt-2 flex gap-4 text-sm text-ink-muted">
            <span>
              Bids: <b className="text-navy">{state.bidCount}</b>
            </span>
            {delta !== null && (
              <span>
                Last raise: <b className="text-navy">+{formatCents(delta)}</b>
              </span>
            )}
            <span>
              Version: <b className="text-navy">v{state.stateVersion}</b>
            </span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <StatusBadge kind="session" value={state.sessionStatus} />
          <StatusBadge kind="sale" value={state.saleStatus} />
          <div className="mt-1 text-right text-[11px] text-ink-faint">
            Room shows: <b className="text-ink-muted">{STATUS_LABEL[pub] ?? pub}</b>
          </div>
        </div>
      </div>
      {reserve !== null && (
        <div className="mt-3 flex items-center gap-3 border-t border-line pt-3 text-xs">
          <span className="font-bold uppercase tracking-widest text-ink-faint">Reserve (private)</span>
          <span className="font-semibold text-ink-muted">{formatCents(reserve)}</span>
          {cur !== null && (
            <span className={`rounded px-1.5 py-0.5 font-bold ${cur >= reserve ? 'bg-ok/15 text-ok' : 'bg-subtle text-ink-muted'}`}>
              {cur >= reserve ? 'Reserve met' : `${formatCents(reserve - cur)} below`}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function StatusBadge({ kind, value }: { kind: 'session' | 'sale'; value: string }) {
  const tone =
    value === 'LIVE' || value === 'ON_THE_MARKET'
      ? 'bg-brand text-white'
      : value === 'PAUSED'
        ? 'bg-warn text-navy-950'
        : value === 'SOLD'
          ? 'bg-ok text-white'
          : value === 'PASSED_IN' || value === 'ENDED'
            ? 'bg-subtle-2 text-navy'
            : 'bg-subtle text-ink-muted'
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-bold uppercase tracking-widest text-ink-faint">{kind}</span>
      <span className={`rounded px-2.5 py-1 text-xs font-bold uppercase tracking-wider ${tone}`}>{STATUS_LABEL[value] ?? value}</span>
    </div>
  )
}

// ───────────────────────── auction controls ─────────────────────────
type Dialog = null | 'SOLD' | 'PASSED_IN' | 'END' | 'UNDO' | 'CORRECT'

export function AuctionControls({
  view,
  enabled,
  pending,
  run,
  dialog,
  setDialog,
}: {
  view: StaffView
  enabled: boolean
  pending: boolean
  run: (cmd: Command) => Promise<boolean>
  dialog: Dialog
  setDialog: (d: Dialog) => void
}) {
  const allowed = allowedCommands(view.state)
  const can = (t: Command['type']) => enabled && !pending && allowed.has(t)
  const s = view.state
  return (
    <div className="panel p-4">
      <div className="panel-title mb-3">Auction controls</div>
      <div className="grid grid-cols-2 gap-2">
        {s.sessionStatus === 'NOT_STARTED' ? (
          <button className="btn-primary col-span-2 py-3 text-lg" disabled={!can('START')} onClick={() => void run({ type: 'START' })}>
            Start auction
          </button>
        ) : s.sessionStatus === 'PAUSED' ? (
          <button className="btn-primary py-3" disabled={!can('RESUME')} onClick={() => void run({ type: 'RESUME' })}>
            Resume <Kbd>P</Kbd>
          </button>
        ) : (
          <button className="btn border border-warn/60 py-3 text-warn hover:bg-warn/10" disabled={!can('PAUSE')} onClick={() => void run({ type: 'PAUSE' })}>
            Pause <Kbd>P</Kbd>
          </button>
        )}
        {s.sessionStatus !== 'NOT_STARTED' && (
          <button className="btn-navy py-3" disabled={!can('ON_THE_MARKET')} onClick={() => void run({ type: 'ON_THE_MARKET' })}>
            On the market
          </button>
        )}
        <button className="btn-ok py-3" disabled={!can('SOLD')} onClick={() => setDialog('SOLD')}>
          Sold…
        </button>
        <button className="btn-ghost py-3" disabled={!can('PASSED_IN')} onClick={() => setDialog('PASSED_IN')}>
          Passed in…
        </button>
        <button className="btn-ghost" disabled={!can('UNDO')} onClick={() => setDialog('UNDO')}>
          Undo last bid <Kbd>Ctrl Z</Kbd>
        </button>
        <button className="btn-ghost" disabled={!can('CORRECT')} onClick={() => setDialog('CORRECT')}>
          Correct last bid…
        </button>
        <button className="btn-ghost col-span-2 text-ink-muted" disabled={!can('END')} onClick={() => setDialog('END')}>
          End auction without result…
        </button>
      </div>

      {dialog === 'SOLD' && (
        <Modal title="Confirm SOLD" tone="ok" onClose={() => setDialog(null)}>
          <p className="text-ink-muted">The room display will show SOLD and the auction will end.</p>
          <div className="my-4 rounded-md bg-ok/10 p-4 text-center text-4xl font-bold text-navy">{formatCents(s.currentBidCents)}</div>
          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button
              className="btn-ok"
              disabled={pending}
              onClick={async () => {
                if (await run({ type: 'SOLD' })) setDialog(null)
              }}
            >
              Confirm sold
            </button>
          </div>
        </Modal>
      )}
      {dialog === 'PASSED_IN' && (
        <ConfirmSimple
          title="Confirm PASSED IN"
          body={`Highest bid ${formatCents(s.currentBidCents)}. The room display will show PASSED IN and the auction will end.`}
          action="Confirm passed in"
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            if (await run({ type: 'PASSED_IN' })) setDialog(null)
          }}
        />
      )}
      {dialog === 'END' && (
        <ConfirmSimple
          title="End auction?"
          body="Ends the session without recording Sold or Passed In. Use only if the auction is withdrawn or abandoned."
          action="End auction"
          danger
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            if (await run({ type: 'END' })) setDialog(null)
          }}
        />
      )}
      {dialog === 'UNDO' && s.currentBidId && (
        <ReasonDialog
          title={`Undo bid ${formatCents(s.currentBidCents)}?`}
          note="The bid stays in the record, marked REVERSED. The previous bid becomes current."
          action="Undo bid"
          onCancel={() => setDialog(null)}
          onConfirm={async (reason) => {
            if (await run({ type: 'UNDO', bidId: s.currentBidId!, reason })) setDialog(null)
          }}
        />
      )}
      {dialog === 'CORRECT' && s.currentBidId && (
        <CorrectDialog
          current={s.currentBidCents!}
          onCancel={() => setDialog(null)}
          onConfirm={async (amountCents, reason) => {
            if (await run({ type: 'CORRECT', bidId: s.currentBidId!, amountCents, reason })) setDialog(null)
          }}
        />
      )}
    </div>
  )
}

function ConfirmSimple(p: { title: string; body: string; action: string; danger?: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Modal title={p.title} tone={p.danger ? 'danger' : 'default'} onClose={p.onCancel}>
      <p className="mb-6 text-ink-muted">{p.body}</p>
      <div className="flex justify-end gap-2">
        <button className="btn-ghost" onClick={p.onCancel}>
          Cancel
        </button>
        <button className={p.danger ? 'btn-danger' : 'btn-primary'} onClick={p.onConfirm}>
          {p.action}
        </button>
      </div>
    </Modal>
  )
}

function ReasonDialog(p: { title: string; note: string; action: string; onCancel: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('')
  return (
    <Modal title={p.title} tone="danger" onClose={p.onCancel}>
      <p className="mb-3 text-sm text-ink-muted">{p.note}</p>
      <label className="label" htmlFor="reason">
        Reason (required, recorded in audit trail)
      </label>
      <textarea id="reason" className="field h-20" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost" onClick={p.onCancel}>
          Cancel
        </button>
        <button className="btn-danger" disabled={!reason.trim()} onClick={() => p.onConfirm(reason)}>
          {p.action}
        </button>
      </div>
    </Modal>
  )
}

function CorrectDialog(p: { current: string; onCancel: () => void; onConfirm: (amountCents: string, reason: string) => void }) {
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const parsed = parseBidInput(amount)
  return (
    <Modal title="Correct last bid" tone="danger" onClose={p.onCancel}>
      <p className="mb-3 text-sm text-ink-muted">
        Recorded as <b className="text-navy">{formatCents(p.current)}</b>. The original stays in the record, marked CORRECTED.
      </p>
      <label className="label" htmlFor="corr-amt">
        Correct amount
      </label>
      <input id="corr-amt" className="field text-2xl font-bold" value={amount} onChange={(e) => setAmount(e.target.value.toUpperCase())} placeholder="e.g. 1265K" />
      <div className="mt-1 h-5 text-sm">
        {amount && (parsed.ok ? <span className="text-brand">{formatCents(parsed.cents)}</span> : <span className="text-bad">{parsed.message}</span>)}
      </div>
      <label className="label mt-2" htmlFor="corr-reason">
        Reason (required)
      </label>
      <textarea id="corr-reason" className="field h-20" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost" onClick={p.onCancel}>
          Cancel
        </button>
        <button className="btn-danger" disabled={!parsed.ok || !reason.trim()} onClick={() => parsed.ok && p.onConfirm(parsed.cents.toString(), reason)}>
          Record correction
        </button>
      </div>
    </Modal>
  )
}

// ───────────────────────── operator lease ─────────────────────────
export function LeasePanel({
  lease,
  hasControl,
  error,
  onAcquire,
  onRelease,
  onTakeover,
  now,
}: {
  lease: OperatorLease | null | undefined
  hasControl: boolean
  error: string | null
  onAcquire: () => void
  onRelease: () => void
  onTakeover: (reason: string) => Promise<void>
  now: number
}) {
  const { user } = useUser()
  const [takeover, setTakeover] = useState(false)
  const secs = lease ? Math.max(0, Math.round((Date.parse(lease.expiresAt) - now) / 1000)) : 0
  return (
    <div className={`panel p-4 ${hasControl ? '' : 'border-warn/40'}`}>
      <div className="mb-2 flex items-center justify-between">
        <span className="panel-title">Operator control</span>
        {lease && <span className="text-[11px] text-ink-faint">lease renews · {secs}s</span>}
      </div>
      {hasControl ? (
        <div className="flex items-center justify-between">
          <span className="font-semibold text-ok">You have control ({user.name})</span>
          <button className="btn-ghost px-3 py-1 text-sm" onClick={onRelease}>
            Release
          </button>
        </div>
      ) : lease ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm">
            Held by <b className="text-warn">{lease.userName}</b>. This console is read-only.
          </span>
          {user.role === 'admin' && (
            <button className="btn-danger px-3 py-1 text-sm" onClick={() => setTakeover(true)}>
              Take over…
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <span className="text-sm text-ink-muted">No one is in control.</span>
          <button className="btn-primary" onClick={onAcquire} data-testid="acquire">
            Take control
          </button>
        </div>
      )}
      {error && <div className="mt-2"><ErrorNote>{error}</ErrorNote></div>}
      {takeover && (
        <ReasonDialog
          title={`Take over from ${lease?.userName}?`}
          note="Their console becomes read-only immediately. This is recorded in the audit trail."
          action="Take over control"
          onCancel={() => setTakeover(false)}
          onConfirm={async (r) => {
            try {
              await onTakeover(r)
              setTakeover(false)
            } catch {
              /* error shown */
            }
          }}
        />
      )}
    </div>
  )
}

// ───────────────────────── room display panel ─────────────────────────
export function DisplayPanel({ view, now, cloudOk }: { view: StaffView; now: number; cloudOk: boolean }) {
  const { user } = useUser()
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('Auction room screen')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const devices = view.devices.filter((d) => !d.revokedAt)

  const approve = async () => {
    setMsg(null)
    try {
      await server.staff.approvePairing(code, view.session.id, label, user)
      setMsg({ ok: true, text: 'Display paired.' })
      setCode('')
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div className="panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="panel-title">Room display</span>
        <div className="flex gap-2">
          <button className="btn-ghost px-2 py-1 text-xs" onClick={() => window.open('/auction/pair', 'gl-room-display', 'width=1280,height=760')}>
            Open display window
          </button>
          <button className="btn-ghost px-2 py-1 text-xs" disabled={!cloudOk || !devices.length} onClick={() => void server.staff.requestResync(view.session.id)}>
            Force resync
          </button>
        </div>
      </div>
      {devices.length === 0 && <p className="mb-3 text-sm text-ink-muted">No display paired with this session.</p>}
      <ul className="mb-3 space-y-2">
        {devices.map((d) => {
          const h = deviceHealth(d, view.state.stateVersion, now)
          return (
            <li key={d.id} className="flex items-center gap-3 rounded-md bg-subtle px-3 py-2 text-sm">
              <span className={`h-2.5 w-2.5 rounded-full ${h.connected ? 'bg-ok' : 'bg-bad'}`} aria-hidden />
              <span className="font-semibold text-navy">{d.label}</span>
              <span className={h.connected ? 'text-ok' : 'text-bad'}>{h.connected ? 'Connected' : 'Disconnected'}</span>
              <span className={h.synced ? 'text-ink-muted' : 'text-warn'}>
                v{Math.max(d.lastAckedVersion, 0)}/{view.state.stateVersion}
              </span>
              <button
                className="ml-auto text-xs font-semibold text-bad underline disabled:opacity-40"
                disabled={!cloudOk}
                onClick={() => void server.staff.revokeDevice(d.id, user)}
              >
                Revoke
              </button>
            </li>
          )
        })}
      </ul>
      <div className="flex gap-2">
        <input
          className="field w-32 text-center font-bold uppercase tracking-[0.3em]"
          placeholder="CODE"
          value={code}
          maxLength={7}
          aria-label="Pairing code"
          onChange={(e) => setCode(e.target.value.toUpperCase())}
        />
        <input className="field flex-1" value={label} aria-label="Display label" onChange={(e) => setLabel(e.target.value)} />
        <button className="btn-primary" disabled={code.trim().length < 6 || !cloudOk} onClick={approve}>
          Approve
        </button>
      </div>
      {msg && <p className={`mt-2 text-sm ${msg.ok ? 'text-ok' : 'text-bad'}`}>{msg.text}</p>}
    </div>
  )
}

// ───────────────────────── bid history ─────────────────────────
export function BidHistory({ bids }: { bids: Bid[] }) {
  return (
    <div className="panel flex min-h-0 flex-col p-4">
      <div className="panel-title mb-2">Bid history</div>
      {bids.length === 0 ? (
        <p className="text-sm text-ink-muted">No bids recorded.</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-2 text-left text-[10px] uppercase tracking-widest text-ink-faint">
              <tr>
                <th className="py-1 pr-2 font-bold">#</th>
                <th className="py-1 pr-2 font-bold">Time</th>
                <th className="py-1 pr-2 text-right font-bold">Amount</th>
                <th className="py-1 font-bold">Status</th>
              </tr>
            </thead>
            <tbody>
              {bids.map((b) => (
                <tr key={b.id} className="border-t border-line">
                  <td className="py-1.5 pr-2 text-ink-faint">{b.seq}</td>
                  <td className="py-1.5 pr-2 text-ink-muted">{time(b.createdAt)}</td>
                  <td className={`py-1.5 pr-2 text-right font-bold ${b.status === 'ACTIVE' ? 'text-navy' : 'text-ink-faint line-through'}`}>
                    {formatCents(b.amountCents)}
                  </td>
                  <td className="py-1.5 text-xs">
                    {b.status === 'ACTIVE' ? (
                      <span className="text-ink-muted">{b.supersedesBidId ? 'Correction' : 'Accepted'}</span>
                    ) : (
                      <span className="font-semibold text-warn">{b.status === 'REVERSED' ? 'Undone' : 'Corrected'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ───────────────────────── offline scribing ─────────────────────────
export function OfflinePanel({ records, sessionId, offline }: { records: OfflineRecord[]; sessionId: string; offline: boolean }) {
  if (!offline && records.length === 0) return null
  return (
    <div className="panel border-warn/50 p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-warn">
          {offline ? 'Offline scribing mode' : 'Provisional records awaiting review'}
        </span>
        <button
          className="btn-ghost px-2 py-1 text-xs"
          disabled={!records.length}
          onClick={() => downloadFile(`offline-scribe-${sessionId}-${Date.now()}.json`, JSON.stringify(records, null, 2))}
        >
          Export backup
        </button>
      </div>
      {offline && (
        <p className="mb-2 text-sm text-ink-muted">
          Cloud unreachable. Bids are saved on this laptop only, marked <b className="text-warn">NOT CLOUD CONFIRMED</b>, and are not shown on the room
          display.
        </p>
      )}
      <ul className="max-h-40 space-y-1 overflow-auto text-sm">
        {records.map((r) => (
          <li key={r.localId} className="flex justify-between rounded bg-warn/5 px-2 py-1">
            <span className="text-ink-muted">{time(r.localCreatedAt)}</span>
            <span className="font-bold text-navy">{r.amountCents ? formatCents(r.amountCents) : r.note}</span>
            <span className="text-[10px] font-bold uppercase text-warn">Not cloud confirmed</span>
          </li>
        ))}
      </ul>
      {!offline && records.length > 0 && (
        <p className="mt-2 text-xs text-ink-faint">Reconciliation into the cloud record requires admin review (Phase 1E). Keep the exported backup.</p>
      )}
    </div>
  )
}

// ───────────────────────── fault injection ─────────────────────────
export function FaultPanel({ faults }: { faults: Faults }) {
  const [open, setOpen] = useState(false)
  const set = (f: Partial<Faults>) => {
    writeFaults(kv, f)
    bus.publish({ type: 'faults.changed' })
  }
  const toggle = (k: keyof Faults, label: string, hint: string) => (
    <label className="flex cursor-pointer items-start gap-2 rounded-md p-2 hover:bg-subtle-2">
      <input type="checkbox" className="mt-1 accent-[#00A1E9]" checked={!!faults[k]} onChange={(e) => set({ [k]: e.target.checked })} />
      <span>
        <span className="block text-sm font-semibold text-navy">{label}</span>
        <span className="block text-xs text-ink-faint">{hint}</span>
      </span>
    </label>
  )
  return (
    <div className="panel border-dashed">
      <button className="flex w-full items-center justify-between p-3 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="panel-title">Test tools · fault injection</span>
        <span className="text-xs text-ink-faint">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="grid grid-cols-2 gap-1 border-t border-line p-2">
          {toggle('consoleOffline', 'Staff laptop offline', 'Cloud API unreachable from consoles')}
          {toggle('displayOffline', 'Room display offline', 'Display loses cloud + socket')}
          {toggle('relayDown', 'Broadcast relay down', 'DB commits, broadcast fails')}
          {toggle('loseNextResponse', 'Lose next response', 'Next action commits, reply lost')}
          {toggle('duplicate', 'Duplicate broadcasts', 'Every event delivered twice')}
          {toggle('reorder', 'Reorder broadcasts', 'Older event arrives after newer')}
          <label className="col-span-1 p-2 text-sm">
            <span className="block font-semibold text-navy">Drop rate {Math.round(faults.dropRate * 100)}%</span>
            <input type="range" min={0} max={1} step={0.1} value={faults.dropRate} onChange={(e) => set({ dropRate: +e.target.value })} className="w-full accent-[#00A1E9]" />
          </label>
          <label className="col-span-1 p-2 text-sm">
            <span className="block font-semibold text-navy">Broadcast delay {faults.delayMs} ms</span>
            <input type="range" min={0} max={4000} step={250} value={faults.delayMs} onChange={(e) => set({ delayMs: +e.target.value })} className="w-full accent-[#00A1E9]" />
          </label>
          <div className="col-span-2 flex justify-end p-2">
            <button className="btn-ghost px-3 py-1 text-xs" onClick={() => set(DEFAULT_FAULTS)}>
              Reset all faults
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
