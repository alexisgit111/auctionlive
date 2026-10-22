import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useSessions, type CloudStatus } from '../../app/hooks'
import { bus, kv, server } from '../../app/server'
import { useUser } from '../../app/user'
import { allowedCommands } from '../../engine/engine'
import { DEFAULT_FAULTS, writeFaults, type Faults } from '../../engine/faults'
import type { StaffView } from '../../engine/mockServer'
import { derivePublicStatus } from '../../engine/publicState'
import type { AudioStatus, Bid, Command, Device, DeviceSummary, OperatorLease } from '../../engine/types'
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
  // long-poll heartbeats arrive every ≤ 3.5 s
  const connected = !d.revokedAt && now - hb <= 8000
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
            <span className={`rounded-full px-2.5 py-0.5 font-bold ${cur >= reserve ? 'bg-ok/15 text-ok' : 'bg-subtle text-ink-muted'}`}>
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
        ? 'bg-warn text-white'
        : value === 'SOLD'
          ? 'bg-ok text-white'
          : value === 'PASSED_IN' || value === 'ENDED'
            ? 'bg-subtle-2 text-navy'
            : 'bg-subtle text-ink-muted'
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-bold uppercase tracking-widest text-ink-faint">{kind}</span>
      <span className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wider ${tone}`}>{STATUS_LABEL[value] ?? value}</span>
    </div>
  )
}

// ───────────────────────── auction controls ─────────────────────────
export type Dialog = null | 'SOLD' | 'PASSED_IN' | 'END' | 'UNDO' | 'CORRECT' | 'REOPEN'

export function AuctionControls({
  view,
  enabled,
  pending,
  run,
  dialog,
  setDialog,
  correctInitial,
}: {
  view: StaffView
  enabled: boolean
  pending: boolean
  run: (cmd: Command) => Promise<boolean>
  dialog: Dialog
  setDialog: (d: Dialog) => void
  correctInitial?: string
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
          <button className="btn-ghost py-3" disabled={!can('PAUSE')} onClick={() => void run({ type: 'PAUSE' })}>
            Pause <Kbd>P</Kbd>
          </button>
        )}
        {s.sessionStatus !== 'NOT_STARTED' &&
          (s.saleStatus === 'ON_THE_MARKET' ? (
            <button
              className="btn-navy py-3"
              disabled={!can('OFF_MARKET')}
              onClick={() => void run({ type: 'OFF_MARKET' })}
              title="Take the property off the market (removes the On the market sticker)"
            >
              Undo on the market
            </button>
          ) : (
            <button className="btn-primary py-3" disabled={!can('ON_THE_MARKET')} onClick={() => void run({ type: 'ON_THE_MARKET' })}>
              On the market
            </button>
          ))}
        <DeskCall n={1} active={s.call === 1} disabled={!can('FIRST_CALL')} run={run} />
        <DeskCall n={2} active={s.call === 2} disabled={!can('SECOND_CALL')} run={run} />
        <button className="btn-primary py-3" disabled={!can('SOLD')} onClick={() => void run({ type: 'SOLD' })}>
          Sold
        </button>
        <button className="btn-ghost py-3" disabled={!can('PASSED_IN')} onClick={() => void run({ type: 'PASSED_IN' })}>
          Pass in
        </button>
        <button
          className="btn-ghost col-span-2 py-2.5"
          disabled={!can('WITHDRAWN_SOLD')}
          onClick={() => void run({ type: 'WITHDRAWN_SOLD' })}
        >
          Withdrawn &amp; Sold
        </button>
        <button
          className="btn-ghost"
          disabled={!can('UNDO') || !s.currentBidId}
          onClick={() => void run({ type: 'UNDO', bidId: s.currentBidId!, reason: 'Undone on console' })}
        >
          Undo last bid <Kbd>Ctrl Z</Kbd>
        </button>
        <button className="btn-ghost" disabled={!can('CORRECT')} onClick={() => setDialog('CORRECT')}>
          Correct last bid…
        </button>
        {s.sessionStatus !== 'NOT_STARTED' && (
          <button
            data-testid="toggle-overlay"
            className={`${s.overlayHidden ? 'btn-navy' : 'btn-ghost'} col-span-2`}
            disabled={!can('SET_OVERLAY')}
            onClick={() => void run({ type: 'SET_OVERLAY', hidden: !s.overlayHidden })}
            title="Hide or show every sticker on the room display (status circle and photo badge)"
          >
            {s.overlayHidden ? 'Show room screen stickers' : 'Remove room screen stickers'}
          </button>
        )}
        {s.sessionStatus !== 'NOT_STARTED' && (
          <button
            data-testid="toggle-price"
            className={`${s.priceHidden ? 'btn-navy' : 'btn-ghost'} col-span-2`}
            disabled={!can(s.priceHidden ? 'SHOW_PRICE' : 'HIDE_PRICE')}
            onClick={() => void run({ type: s.priceHidden ? 'SHOW_PRICE' : 'HIDE_PRICE' })}
          >
            {s.priceHidden ? 'Show the price on the room screen' : 'Hide the price on the room screen (or 0 Enter)'}
          </button>
        )}
        {s.sessionStatus === 'ENDED' && (
          <button
            className="btn-primary col-span-2 py-3"
            disabled={!can('REOPEN')}
            onClick={() => void run({ type: 'REOPEN', reason: 'Reopened on console' })}
          >
            {s.saleStatus === 'SOLD' ? 'Undo SOLD — reopen auction' : s.saleStatus === 'PASSED_IN' ? 'Undo PASSED IN — reopen' : 'Reopen auction'}
          </button>
        )}
        <button className="btn-ghost col-span-2 !text-bad" disabled={!can('END')} onClick={() => void run({ type: 'END' })}>
          End auction
        </button>
      </div>

      <AuctionDialogs view={view} pending={pending} run={run} dialog={dialog} setDialog={setDialog} correctInitial={correctInitial} />
    </div>
  )
}

/** Confirmation dialogs for Sold / Passed in / End / Undo / Correct — shared by the desktop and phone consoles. */
/** 1st / 2nd call on the desktop: first click arms, second click (within 4 s) sends. */
function DeskCall({ n, active, disabled, run }: { n: 1 | 2; active: boolean; disabled: boolean; run: (cmd: Command) => Promise<boolean> }) {
  const [arm, setArm] = useState(false)
  useEffect(() => {
    if (!arm) return
    const t = setTimeout(() => setArm(false), 4000)
    return () => clearTimeout(t)
  }, [arm])
  const label = n === 1 ? '1st Call' : '2nd Call'
  const color = n === 1 ? 'warn' : 'bad'
  return (
    <button
      data-testid={`desk-call-${n}`}
      className={`relative py-3 ${arm ? 'btn-primary' : active ? 'btn-navy' : 'btn-ghost'}`}
      disabled={disabled}
      onClick={() => {
        if (!arm) return setArm(true)
        setArm(false)
        void run({ type: n === 1 ? 'FIRST_CALL' : 'SECOND_CALL' })
      }}
    >
      {arm ? `Confirm ${label} ✓` : label}
      {!arm && <span className={`absolute right-2.5 top-2.5 h-2 w-2 rounded-full ${active ? (color === 'warn' ? 'bg-warn' : 'bg-bad') : 'bg-black/10'}`} aria-hidden />}
    </button>
  )
}

export function AuctionDialogs({
  view,
  run,
  dialog,
  setDialog,
  correctInitial,
}: {
  view: StaffView
  pending: boolean
  run: (cmd: Command) => Promise<boolean>
  dialog: Dialog
  setDialog: (d: Dialog) => void
  /** Pre-filled amount for "Correct last bid" (e.g. typed on the keypad) */
  correctInitial?: string
}) {
  const s = view.state
  return (
    <>
      {dialog === 'CORRECT' && s.currentBidId && (
        <CorrectDialog
          current={s.currentBidCents!}
          initial={correctInitial}
          onCancel={() => setDialog(null)}
          onConfirm={async (amountCents, reason) => {
            if (await run({ type: 'CORRECT', bidId: s.currentBidId!, amountCents, reason: reason.trim() || 'Corrected on console' })) setDialog(null)
          }}
        />
      )}
    </>
  )
}

function ReasonChips({ reasons, value, onPick }: { reasons?: string[]; value: string; onPick: (r: string) => void }) {
  if (!reasons?.length) return null
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {reasons.map((r) => (
        <button
          key={r}
          type="button"
          className={`rounded-full border px-3 py-1.5 text-sm font-semibold ${value === r ? 'border-brand bg-brand text-white' : 'border-line bg-white text-navy hover:bg-brand/5'}`}
          onClick={() => onPick(r)}
        >
          {r}
        </button>
      ))}
    </div>
  )
}

function CorrectDialog(p: { current: string; initial?: string; onCancel: () => void; onConfirm: (amountCents: string, reason: string) => void }) {
  const [amount, setAmount] = useState(p.initial ?? '')
  const [reason, setReason] = useState('')
  const parsed = parseBidInput(amount)
  const same = parsed.ok && parsed.cents.toString() === p.current
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
        {amount &&
          (!parsed.ok ? (
            <span className="text-bad">{parsed.message}</span>
          ) : same ? (
            <span className="text-bad">Same as the recorded amount</span>
          ) : (
            <span className="text-brand">
              {formatCents(parsed.cents)}{' '}
              <span className="text-ink-muted">({parsed.cents < BigInt(p.current) ? 'lower' : 'higher'} than recorded)</span>
            </span>
          ))}
      </div>
      <label className="label mt-2" htmlFor="corr-reason">
        Reason (optional)
      </label>
      <ReasonChips reasons={['Misheard', 'Typo', 'Auctioneer corrected']} value={reason} onPick={setReason} />
      <textarea id="corr-reason" className="field h-16" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost" onClick={p.onCancel}>
          Cancel
        </button>
        <button className="btn-danger" disabled={!parsed.ok || same} onClick={() => parsed.ok && p.onConfirm(parsed.cents.toString(), reason)}>
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
  flat = false,
}: {
  lease: OperatorLease | null | undefined
  hasControl: boolean
  error: string | null
  onAcquire: () => void
  onRelease: () => void
  onTakeover: (reason: string) => Promise<void>
  now: number
  /** Phone console: no border, calculator-style keys */
  flat?: boolean
}) {
  const { user } = useUser()
  const key = flat ? 'm-key-dark px-4 py-2.5 text-sm font-semibold' : ''
  const secs = lease ? Math.max(0, Math.round((Date.parse(lease.expiresAt) - now) / 1000)) : 0
  return (
    <div className={flat ? 'px-2 py-1.5' : `panel p-4 ${hasControl ? '' : 'border-warn/40'}`}>
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
          <button className={key || 'btn-danger px-3 py-1 text-sm'} data-testid="takeover" onClick={() => void onTakeover('').catch(() => {})}>
            Take over
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <span className="text-sm text-ink-muted">No one is in control.</span>
          <button className={key || 'btn-primary'} onClick={onAcquire} data-testid="acquire">
            Take control
          </button>
        </div>
      )}
      {error && <div className="mt-2"><ErrorNote>{error}</ErrorNote></div>}
    </div>
  )
}

// ───────────────────────── room screen media ─────────────────────────
/** What the room screen's speakers report (the first connected screen). */
export function screenAudio(view: StaffView, now: number): AudioStatus | 'no-screen' {
  const live = view.devices.filter((d) => deviceHealth(d, view.state.stateVersion, now).connected)
  if (live.length === 0) return 'no-screen'
  const order: AudioStatus[] = ['blocked', 'error', 'loading', 'playing', 'off']
  const statuses = live.map((d) => d.audioStatus ?? 'off')
  return order.find((o) => statuses.includes(o)) ?? 'off'
}

export const AUDIO_TEXT: Record<AudioStatus | 'no-screen', { text: string; tone: string }> = {
  playing: { text: '🔊 Playing on the room screen', tone: 'text-ok' },
  loading: { text: 'Loading music on the room screen…', tone: 'text-ink-muted' },
  blocked: { text: '⚠ Sound blocked on the room screen — click the screen once', tone: 'text-warn' },
  error: { text: '⚠ The room screen could not play the music file', tone: 'text-bad' },
  off: { text: 'Silent', tone: 'text-ink-muted' },
  'no-screen': { text: 'No room screen connected', tone: 'text-ink-muted' },
}

/** Volume changes are sent once the slider rests (not on every pixel). */
export function useVolume(view: StaffView, run: (cmd: Command) => Promise<boolean>, enabled: boolean) {
  const server = view.state.volume ?? 80
  const [v, setV] = useState(server)
  const dirty = useRef(false)
  const runRef = useRef(run)
  runRef.current = run
  useEffect(() => {
    if (!dirty.current) setV(server)
  }, [server])
  useEffect(() => {
    if (!dirty.current || !enabled) return
    const t = setTimeout(() => {
      dirty.current = false
      if (v !== server) void runRef.current({ type: 'SET_VOLUME', percent: v })
    }, 450)
    return () => clearTimeout(t)
  }, [v, server, enabled])
  return [
    v,
    (n: number) => {
      dirty.current = true
      setV(n)
    },
  ] as const
}

export function RoomMediaPanel({
  view,
  now,
  enabled,
  pending,
  run,
}: {
  view: StaffView
  now: number
  enabled: boolean
  pending: boolean
  run: (cmd: Command) => Promise<boolean>
}) {
  const { user } = useUser()
  const s = view.state
  const media = useQuery({ queryKey: ['media'], queryFn: () => server.media.get(), staleTime: 30_000 })
  const [vol, setVol] = useVolume(view, run, enabled)
  const audio = screenAudio(view, now)
  const silent = media.data && !media.data.welcomeMusic && !media.data.pauseMusic
  const shownAudio = (s.welcomeOn || s.musicOn) ? audio : audio === 'no-screen' ? audio : 'off'
  return (
    <div className="panel p-4" data-testid="room-media-panel">
      <div className="mb-3 flex items-center justify-between">
        <span className="panel-title">Room screen media</span>
        {user.role === 'admin' && (
          <Link to="/auction/media" className="text-xs font-semibold text-brand underline">
            Image &amp; music…
          </Link>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button
          data-testid="toggle-welcome"
          className={`${s.welcomeOn ? 'btn-primary' : 'btn-ghost'} py-3`}
          disabled={!enabled || pending}
          onClick={() => void run({ type: 'SET_WELCOME', on: !s.welcomeOn })}
        >
          Welcome screen {s.welcomeOn ? 'ON' : 'OFF'}
        </button>
        <button
          data-testid="toggle-music"
          className={`${s.musicOn ? 'btn-primary' : 'btn-ghost'} py-3`}
          disabled={!enabled || pending}
          onClick={() => void run({ type: 'SET_MUSIC', on: !s.musicOn })}
        >
          Music {s.musicOn ? 'ON' : 'OFF'}
        </button>
      </div>
      <label className="mt-3 flex items-center gap-3 text-sm text-ink-muted">
        <span className="w-14 shrink-0 font-semibold">Volume</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={vol}
          disabled={!enabled}
          aria-label="Room screen volume"
          className="flex-1 accent-brand"
          onChange={(e) => setVol(Number(e.target.value))}
        />
        <span className="w-10 text-right font-semibold tabular-nums text-navy">{vol}</span>
      </label>
      <div className={`mt-2 text-sm font-semibold ${AUDIO_TEXT[shownAudio].tone}`} data-testid="screen-audio">
        {AUDIO_TEXT[shownAudio].text}
      </div>
      {silent && <div className="mt-1 text-xs text-warn">No music uploaded yet{user.role === 'admin' ? ' — add it under Media' : ''}.</div>}
      <div className="mt-1 text-xs text-ink-faint">Start auction closes the welcome screen · Pause starts the music</div>
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
      {devices.length === 0 && (
        <>
          <p className="mb-2 text-sm text-ink-muted">No screen is showing this session yet.</p>
          <OtherScreens sessionId={view.session.id} now={now} cloudOk={cloudOk} prominent />
        </>
      )}
      <ul className="mb-3 space-y-2">
        {devices.map((d) => {
          const h = deviceHealth(d, view.state.stateVersion, now)
          return (
            <li key={d.id} className="flex items-center gap-3 rounded-xl border border-white/90 bg-white/70 px-3 py-2 text-sm shadow-sm">
              <span className={`h-2.5 w-2.5 rounded-full ${h.connected ? 'bg-ok' : 'bg-bad'}`} aria-hidden />
              <span className="font-semibold text-navy">{d.label}</span>
              <span className={h.connected ? 'text-ok' : 'text-bad'}>{h.connected ? 'Connected' : 'Disconnected'}</span>
              <span className={h.synced ? 'text-ink-muted' : 'text-warn'}>
                v{Math.max(d.lastAckedVersion, 0)}/{view.state.stateVersion}
              </span>
              <MoveToSession deviceId={d.id} currentSessionId={view.session.id} disabled={!cloudOk} />
              <button
                className="text-xs font-semibold text-bad underline disabled:opacity-40"
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
      {devices.length > 0 && <OtherScreens sessionId={view.session.id} now={now} cloudOk={cloudOk} />}
      {devices.length === 0 && (
        <p className="mt-2 text-xs text-ink-faint">New screen: open /auction/pair on it, then enter its code above.</p>
      )}
    </div>
  )
}

/**
 * Top-of-console prompt: this session has no screen, but a screen is online on another session.
 * One tap moves it here (no re-pairing).
 */
export function ScreenSwitchBanner({ view, now, cloudOk, compact = false }: { view: StaffView; now: number; cloudOk: boolean; compact?: boolean }) {
  const { user } = useUser()
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const q = useQuery({ queryKey: ['devices'], queryFn: () => server.staff.listDevices(), refetchInterval: 5000 })
  const here = view.devices.filter((d) => !d.revokedAt && deviceHealth(d, view.state.stateVersion, now).connected).length
  if (here > 0 || !q.data) return null
  const online = q.data.filter(
    (d) => d.sessionId !== view.session.id && !!d.lastHeartbeatAt && now - Date.parse(d.lastHeartbeatAt) <= 8000,
  )
  if (online.length === 0) return null
  const move = async (d: DeviceSummary) => {
    setBusy(d.id)
    setErr(null)
    try {
      await server.staff.moveDevice(d.id, view.session.id, user)
      await qc.invalidateQueries({ queryKey: ['devices'] })
      await qc.invalidateQueries({ queryKey: ['staff', view.session.id] })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className={`border border-brand/30 bg-brand-50/80 backdrop-blur-md ${compact ? 'rounded-2xl px-3 py-2 shadow-[0_6px_18px_-10px_rgba(0,161,233,0.6)]' : 'rounded-2xl px-4 py-3 shadow-[0_8px_24px_-12px_rgba(0,161,233,0.5)]'}`} data-testid="screen-switch">
      {online.map((d) => (
        <div key={d.id} className="flex items-center gap-3">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-ok" aria-hidden />
          <span className={`min-w-0 flex-1 ${compact ? 'text-[13px]' : 'text-sm'} text-navy`}>
            <b>{d.label}</b> is showing <b>{d.sessionAddress || d.sessionTitle || 'another session'}</b>
          </span>
          <button
            className={`btn-primary shrink-0 ${compact ? 'px-3 py-1.5 text-[13px]' : 'px-4 py-2 text-sm'}`}
            disabled={!cloudOk || busy !== null}
            onClick={() => void move(d)}
          >
            {busy === d.id ? 'Switching…' : 'Show this session'}
          </button>
        </div>
      ))}
      {err && <div className="mt-1 text-sm text-bad">{err}</div>}
    </div>
  )
}

/** Send a screen of this session to another session (e.g. the next property). */
function MoveToSession({ deviceId, currentSessionId, disabled }: { deviceId: string; currentSessionId: string; disabled: boolean }) {
  const { user } = useUser()
  const qc = useQueryClient()
  const sessions = useSessions()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const others = (sessions.data ?? []).filter((x) => x.session.id !== currentSessionId)
  if (others.length === 0) return <span className="ml-auto" />
  return (
    <>
    {err && <span className="ml-auto text-xs text-bad">{err}</span>}
    <select
      className={`${err ? '' : 'ml-auto '}max-w-[11rem] rounded-full border border-line bg-white px-3 py-1 text-xs font-semibold text-navy`}
      aria-label="Move screen to session"
      value=""
      disabled={disabled || busy}
      onChange={async (e) => {
        const to = e.target.value
        if (!to) return
        setBusy(true)
        setErr(null)
        try {
          await server.staff.moveDevice(deviceId, to, user)
          await qc.invalidateQueries({ queryKey: ['staff', currentSessionId] })
          await qc.invalidateQueries({ queryKey: ['devices'] })
        } catch (err) {
          setErr(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }}
    >
      <option value="">{busy ? 'Moving…' : 'Move to…'}</option>
      {others.map(({ session: x, state }) => (
        <option key={x.id} value={x.id}>
          {x.property.addressLine}
          {x.property.suburb ? `, ${x.property.suburb}` : ''} — {state.sessionStatus.replace('_', ' ').toLowerCase()}
        </option>
      ))}
    </select>
    </>
  )
}

/** Screens paired with other sessions — move one here without re-pairing. */
function OtherScreens({ sessionId, now, cloudOk, prominent = false }: { sessionId: string; now: number; cloudOk: boolean; prominent?: boolean }) {
  const { user } = useUser()
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const q = useQuery({ queryKey: ['devices'], queryFn: () => server.staff.listDevices(), refetchInterval: 5000 })
  const DAY = 86_400_000
  const others = (q.data ?? [])
    .filter((d) => d.sessionId !== sessionId)
    .map((d) => ({ d, online: !!d.lastHeartbeatAt && now - Date.parse(d.lastHeartbeatAt) <= 8000 }))
    // only screens seen in the last day (old ones stay revocable from their own session)
    .filter(({ d }) => d.lastHeartbeatAt && now - Date.parse(d.lastHeartbeatAt) < DAY)
    .sort((a, b) => Number(b.online) - Number(a.online))
  if (q.isError)
    return (
      <p className="mt-3 text-sm text-bad">
        Cannot list the room screens — the server&apos;s <code>api</code> folder is probably out of date. ({q.error instanceof Error ? q.error.message : ''})
      </p>
    )
  if (others.length === 0) return null

  const move = async (d: DeviceSummary) => {
    setBusy(d.id)
    setErr(null)
    try {
      await server.staff.moveDevice(d.id, sessionId, user)
      await qc.invalidateQueries({ queryKey: ['devices'] })
      await qc.invalidateQueries({ queryKey: ['staff', sessionId] })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={prominent ? 'mb-3 rounded-2xl border border-brand/30 bg-brand/5 p-3' : 'mt-4 border-t border-line pt-3'} data-testid="other-screens">
      <div className="mb-2 text-xs font-bold uppercase tracking-widest text-ink-faint">
        {prominent ? 'Switch a room screen to this session' : 'Screens on other sessions'}
      </div>
      <ul className="space-y-2">
        {others.map(({ d, online }) => (
          <li key={d.id} className="flex items-center gap-3 rounded-xl border border-white/90 bg-white/70 px-3 py-2 text-sm shadow-sm">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${online ? 'bg-ok' : 'bg-ink-faint'}`} aria-hidden />
            <div className="min-w-0">
              <div className="font-semibold text-navy">{d.label}</div>
              <div className="truncate text-xs text-ink-muted">
                {online ? 'Showing' : 'Offline · last'}: {d.sessionAddress || d.sessionTitle || 'another session'}
              </div>
            </div>
            <button
              className="btn-primary ml-auto shrink-0 px-3 py-1 text-xs"
              disabled={!cloudOk || busy !== null}
              onClick={() => void move(d)}
            >
              {busy === d.id ? 'Moving…' : 'Show this session'}
            </button>
          </li>
        ))}
      </ul>
      {err && <p className="mt-2 text-sm text-bad">{err}</p>}
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
            <thead className="sticky top-0 bg-white/90 text-left backdrop-blur text-[10px] uppercase tracking-widest text-ink-faint">
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
          <li key={r.localId} className="flex justify-between rounded-lg bg-warn/5 px-2 py-1">
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
    <label className="flex cursor-pointer items-start gap-2 rounded-xl p-2 hover:bg-white/70">
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
