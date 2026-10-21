/**
 * Phone console — finance-calculator layout.
 *   type 1K → [+]   preview current + $1,000 → tap [+] again to send
 *   type 1.25M → [SET] preview $1,250,000   → tap [SET] again to send
 *   [+5K] chip → preview → tap the chip again to send
 * Same commands, idempotency and audit trail as the desktop console.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { CloudStatus, useOperatorLease } from '../../app/hooks'
import { setLayoutPref } from '../../app/layout'
import { server } from '../../app/server'
import { useAuth, useUser } from '../../app/user'
import { allowedCommands } from '../../engine/engine'
import type { SessionSummary, StaffView } from '../../engine/mockServer'
import { derivePublicStatus } from '../../engine/publicState'
import type { Command } from '../../engine/types'
import { computeTarget, typeKey, type CalcResult } from '../../lib/calcEntry'
import { formatCents, type Cents } from '../../lib/money'
import { QUICK_INCREMENTS_K } from './BidEntry'
import { AUDIO_TEXT, AuctionDialogs, LeasePanel, ScreenSwitchBanner, screenAudio, useDisplaysHealth, useVolume, type Dialog } from './panels'

interface Props {
  view: StaffView
  sessions: SessionSummary[]
  sessionId: string | null
  onSessionChange: (id: string) => void
  cloud: CloudStatus
  now: number
  lease: ReturnType<typeof useOperatorLease>
  pending: boolean
  canBid: boolean
  bidDisabledReason: string | null
  controlsEnabled: boolean
  offline: boolean
  offlineCount: number
  apiOutdated: boolean
  error: { code: string; message: string } | null
  clearError: () => void
  run: (cmd: Command) => Promise<boolean>
  submitBid: (cents: Cents) => Promise<boolean>
  dialog: Dialog
  setDialog: (d: Dialog) => void
  correctInitial?: string
  /** Open "Correct last bid" pre-filled with this amount */
  onCorrect: (cents: Cents) => void
}

interface Armed {
  key: string
  kind: 'BID' | 'CORRECT'
  target: Cents
  increment: Cents | null
  warning: string | null
}

const PUBLIC_LABEL: Record<string, string> = {
  NOT_STARTED: 'Not started',
  LIVE: 'Live',
  ON_THE_MARKET: 'On the market',
  PAUSED: 'Paused',
  SOLD: 'Sold',
  PASSED_IN: 'Passed in',
  ENDED: 'Ended',
}

const buzz = (pattern: number | number[]) => {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    /* not supported (iPhone) */
  }
}

export function MobileConsole(p: Props) {
  const s = p.view.state
  const current = s.currentBidCents ? BigInt(s.currentBidCents) : null
  const defInc = BigInt(p.view.session.defaultIncrementCents)
  const allowed = allowedCommands(s)
  const can = (t: Command['type']) => p.controlsEnabled && !p.pending && allowed.has(t)
  const keysOn = p.canBid && !p.pending
  const pub = derivePublicStatus(s)
  const displays = useDisplaysHealth(p.view, p.now)
  const audio = screenAudio(p.view, p.now)

  const [input, setInput] = useState('')
  const [armed, setArmed] = useState<Armed | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [sheet, setSheet] = useState(false)
  const [flash, setFlash] = useState(0)
  const [sending, setSending] = useState(false)

  // Anything changing underneath (another bid, pause…) cancels a pending preview.
  useEffect(() => setArmed(null), [s.currentBidCents, s.sessionStatus, s.saleStatus])

  const press = (k: string) => {
    if (!keysOn) return
    setArmed(null)
    setMsg(null)
    setInput((v) => typeKey(v, k))
    buzz(5)
  }

  const op = async (keyId: string, compute: () => CalcResult) => {
    if (!keysOn || sending) return
    if (armed?.key === keyId && armed.kind === 'CORRECT') {
      setArmed(null)
      setInput('')
      p.onCorrect(armed.target)
      return
    }
    if (armed?.key === keyId) {
      setSending(true)
      const ok = await p.submitBid(armed.target)
      setSending(false)
      setArmed(null)
      if (ok) {
        setInput('')
        setFlash((f) => f + 1)
        buzz(30)
      }
      return
    }
    const r = compute()
    if (!r.ok) {
      setArmed(null)
      setMsg(r.message)
      buzz([20, 40, 20])
      return
    }
    if (r.kind === 'CORRECT' && !allowed.has('CORRECT')) {
      setMsg('Lower than the current bid — nothing to correct right now')
      return
    }
    setMsg(null)
    setArmed({ key: keyId, kind: r.kind, target: r.target, increment: r.increment, warning: r.warning })
    buzz(10)
  }

  const plus = () => op('ADD', () => computeTarget('ADD', input, current, defInc))
  const set = () => op('SET', () => computeTarget('SET', input, current, defInc))
  const chip = (k: number) => op(`chip${k}`, () => computeTarget('ADD', `${k}K`, current, defInc))

  const statusTone =
    pub === 'SOLD' ? 'bg-ok' : pub === 'ON_THE_MARKET' ? 'bg-brand' : pub === 'PAUSED' ? 'bg-warn' : pub === 'LIVE' ? 'bg-ok' : 'bg-white/20'

  return (
    <div className="fixed inset-0 z-30 flex touch-manipulation select-none flex-col bg-surface" data-testid="mobile-console">
      {/* ── top bar ── */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-white px-2 pt-[env(safe-area-inset-top)]">
        <select
          aria-label="Session"
          className="min-w-0 flex-1 truncate rounded-md border border-line bg-white px-2 py-1.5 text-[15px] font-semibold text-navy"
          value={p.sessionId ?? ''}
          onChange={(e) => p.onSessionChange(e.target.value)}
        >
          {p.sessions.map(({ session, state }) => (
            <option key={session.id} value={session.id}>
              {session.property.addressLine}
              {session.property.suburb ? `, ${session.property.suburb}` : ''} — {state.sessionStatus.replace('_', ' ').toLowerCase()}
            </option>
          ))}
        </select>
        <Dot ok={p.cloud === 'ONLINE'} warn={p.cloud === 'DEGRADED'} label="Cloud" />
        <Dot ok={displays.connected > 0 && !displays.outOfSync} warn={displays.connected > 0 && displays.outOfSync} label="Screen" />
        <button
          className="flex h-9 w-10 items-center justify-center rounded-md border border-line text-navy"
          aria-label="Menu"
          data-testid="mobile-menu"
          onClick={() => setSheet(true)}
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
      </div>

      {/* ── banners ── */}
      {p.apiOutdated && <Banner tone="bad">Server files are out of date — upload the api folder again.</Banner>}
      {p.offline && (
        <Banner tone="bad">
          OFFLINE — bids are saved on this phone only and are NOT on the room screen.{p.offlineCount ? ` (${p.offlineCount} saved)` : ''}
        </Banner>
      )}
      {p.error && (
        <button className="shrink-0 bg-bad px-3 py-2 text-left text-sm font-semibold text-white" onClick={p.clearError}>
          {p.error.message} <span className="opacity-70">· tap to dismiss</span>
        </button>
      )}

      <ScreenSwitchBanner view={p.view} now={p.now} cloudOk={p.cloud !== 'OFFLINE'} compact />

      {/* ── calculator display ── */}
      <section className="shrink-0 bg-navy px-4 pb-3 pt-2 text-white">
        <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em]">
          <span className={`rounded-full px-2 py-0.5 text-white ${statusTone}`} data-testid="mobile-status">
            {PUBLIC_LABEL[pub]}
          </span>
          {s.overlayHidden && <span className="rounded-full bg-white/15 px-2 py-0.5">Stickers hidden</span>}
          <span className="ml-auto text-white/60">
            {s.bidCount} bid{s.bidCount === 1 ? '' : 's'} · v{s.stateVersion}
          </span>
        </div>
        <div className="mt-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/60">Current bid</div>
        <div
          key={flash}
          data-testid="mobile-current"
          className={`text-[clamp(2.4rem,12vw,3.6rem)] font-bold leading-none tabular-nums tracking-tight ${flash ? 'bid-flash' : ''}`}
        >
          {formatCents(s.currentBidCents) === '—' ? 'No bids' : formatCents(s.currentBidCents)}
        </div>

        <div
          className={`mt-3 flex min-h-[64px] items-center gap-3 rounded-lg px-3 py-2 ${
            armed?.kind === 'CORRECT' ? 'bg-warn' : armed ? 'bg-ok/90' : msg ? 'bg-bad/80' : 'bg-navy-700'
          }`}
          aria-live="polite"
        >
          <div className="min-w-0 flex-1 text-[13px] leading-tight">
            {armed ? (
              <>
                <div className="font-semibold text-white/85">
                  {armed.kind === 'CORRECT'
                    ? `Correct last bid ${formatCents(s.currentBidCents)} → `
                    : armed.increment !== null
                      ? `+${formatCents(armed.increment)} → `
                      : 'Opening bid → '}
                </div>
                <div className="text-2xl font-bold tabular-nums" data-testid="mobile-preview">
                  {formatCents(armed.target)}
                </div>
                {armed.warning && armed.kind !== 'CORRECT' && <div className="mt-0.5 font-bold text-amber-200">{armed.warning}</div>}
              </>
            ) : msg ? (
              <span className="font-semibold">{msg}</span>
            ) : !p.canBid ? (
              <span className="text-white/60">{p.bidDisabledReason ?? 'Bidding is closed'}</span>
            ) : (
              <span className="text-white/50">
                Type <b className="text-white/80">1K</b> then <b className="text-white/80">+</b>, or <b className="text-white/80">1.25M</b> then{' '}
                <b className="text-white/80">SET</b>
              </span>
            )}
          </div>
          <div className="shrink-0 text-right text-3xl font-bold tabular-nums text-brand-400" data-testid="mobile-input">
            {input || <span className="text-white/20">0</span>}
          </div>
        </div>
        {armed && (
          <div className="mt-1 text-center text-[11px] font-semibold text-white/70">
            {armed.kind === 'CORRECT' ? 'Tap SET again to correct (asks for a reason)' : 'Tap the green key again to send'} · any digit to cancel
          </div>
        )}
      </section>

      {/* ── control / status row ── */}
      {!p.lease.hasControl ? (
        <div className="shrink-0 p-2">
          <LeasePanel
            lease={p.view.lease}
            hasControl={p.lease.hasControl}
            error={p.lease.error}
            onAcquire={p.lease.acquire}
            onRelease={p.lease.release}
            onTakeover={p.lease.takeover}
            now={p.now}
          />
        </div>
      ) : (
        <div className="grid shrink-0 grid-cols-4 gap-1.5 px-2 pt-2">
          {s.sessionStatus === 'NOT_STARTED' ? (
            <Act tone="brand" disabled={!can('START')} onClick={() => void p.run({ type: 'START' })} wide>
              Start auction
            </Act>
          ) : s.sessionStatus === 'ENDED' ? (
            <Act tone="navyOutline" disabled={!can('REOPEN')} onClick={() => p.setDialog('REOPEN')} wide>
              {s.saleStatus === 'SOLD' ? 'Undo SOLD — reopen…' : s.saleStatus === 'PASSED_IN' ? 'Undo PASSED IN — reopen…' : 'Reopen auction…'}
            </Act>
          ) : s.sessionStatus === 'PAUSED' ? (
            <Act tone="brand" disabled={!can('RESUME')} onClick={() => void p.run({ type: 'RESUME' })}>
              Resume
            </Act>
          ) : (
            <Act tone="warn" disabled={!can('PAUSE')} onClick={() => void p.run({ type: 'PAUSE' })}>
              Pause
            </Act>
          )}
          {s.sessionStatus !== 'NOT_STARTED' && s.sessionStatus !== 'ENDED' && (
            <>
              {s.saleStatus === 'ON_THE_MARKET' ? (
                <Act tone="navyOutline" disabled={!can('OFF_MARKET')} onClick={() => void p.run({ type: 'OFF_MARKET' })}>
                  Off market
                </Act>
              ) : (
                <Act tone="navy" disabled={!can('ON_THE_MARKET')} onClick={() => void p.run({ type: 'ON_THE_MARKET' })}>
                  On market
                </Act>
              )}
              <Act tone="ok" disabled={!can('SOLD')} onClick={() => p.setDialog('SOLD')}>
                Sold…
              </Act>
              <Act tone="ghost" disabled={!can('PASSED_IN')} onClick={() => p.setDialog('PASSED_IN')}>
                Passed in…
              </Act>
            </>
          )}
        </div>
      )}

      {/* ── room screen media ── */}
      {p.lease.hasControl && (
        <div className="grid shrink-0 grid-cols-2 gap-1.5 px-2 pt-1.5">
          <Toggle on={!!s.welcomeOn} disabled={!can('SET_WELCOME')} onClick={() => void p.run({ type: 'SET_WELCOME', on: !s.welcomeOn })} testId="m-toggle-welcome">
            🖼 Welcome {s.welcomeOn ? 'ON' : 'OFF'}
          </Toggle>
          <Toggle on={!!s.musicOn} disabled={!can('SET_MUSIC')} onClick={() => void p.run({ type: 'SET_MUSIC', on: !s.musicOn })} testId="m-toggle-music" warn={(s.welcomeOn || s.musicOn) && (audio === 'blocked' || audio === 'error')}>
            ♪ Music {s.musicOn ? 'ON' : 'OFF'}
          </Toggle>
        </div>
      )}
      {(s.welcomeOn || s.musicOn) && (audio === 'blocked' || audio === 'error') && (
        <div className="shrink-0 px-3 pt-1 text-center text-[12px] font-bold text-warn">{AUDIO_TEXT[audio].text}</div>
      )}

      {/* ── quick increments ── */}
      <div className="grid shrink-0 grid-cols-6 gap-1.5 px-2 pt-1.5">
        {QUICK_INCREMENTS_K.map((k) => {
          const on = armed?.key === `chip${k}`
          return (
            <button
              key={k}
              className={`h-11 rounded-lg text-[15px] font-bold tabular-nums disabled:opacity-35 ${
                on ? 'bg-ok text-white' : 'bg-brand-100 text-navy active:bg-brand/30'
              }`}
              disabled={!keysOn || current === null}
              onClick={() => void chip(k)}
            >
              {on ? '✓' : `+${k}K`}
            </button>
          )
        })}
      </div>

      {/* ── keypad ── */}
      <div className="grid min-h-0 flex-1 grid-cols-4 grid-rows-5 gap-1.5 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <Key fn onClick={() => press('C')} disabled={!keysOn}>
          C
        </Key>
        <Key fn onClick={() => press('⌫')} disabled={!keysOn} label="Backspace">
          ⌫
        </Key>
        <Key fn onClick={() => press('K')} disabled={!keysOn}>
          K
        </Key>
        <Key fn onClick={() => press('M')} disabled={!keysOn}>
          M
        </Key>
        <Key onClick={() => press('7')} disabled={!keysOn}>7</Key>
        <Key onClick={() => press('8')} disabled={!keysOn}>8</Key>
        <Key onClick={() => press('9')} disabled={!keysOn}>9</Key>
        <OpKey armed={armed?.key === 'ADD'} sending={sending && armed?.key === 'ADD'} onClick={() => void plus()} disabled={!keysOn} label="Plus" testId="key-plus">
          +
        </OpKey>
        <Key onClick={() => press('4')} disabled={!keysOn}>4</Key>
        <Key onClick={() => press('5')} disabled={!keysOn}>5</Key>
        <Key onClick={() => press('6')} disabled={!keysOn}>6</Key>
        <Key onClick={() => press('1')} disabled={!keysOn}>1</Key>
        <Key onClick={() => press('2')} disabled={!keysOn}>2</Key>
        <Key onClick={() => press('3')} disabled={!keysOn}>3</Key>
        <OpKey
          armed={armed?.key === 'SET'}
          correction={armed?.key === 'SET' && armed.kind === 'CORRECT'}
          sending={sending && armed?.key === 'SET'}
          onClick={() => void set()}
          disabled={!keysOn}
          label="Set"
          testId="key-set"
          small
        >
          SET
        </OpKey>
        <Key onClick={() => press('0')} disabled={!keysOn}>0</Key>
        <Key onClick={() => press('00')} disabled={!keysOn}>00</Key>
        <Key onClick={() => press('.')} disabled={!keysOn}>.</Key>
      </div>

      {/* ── menu sheet ── */}
      {sheet && (
        <MenuSheet
          {...p}
          can={can}
          onClose={() => setSheet(false)}
          screenText={
            displays.paired === 0 ? 'No screen paired' : `${displays.connected}/${displays.paired} screen${displays.paired > 1 ? 's' : ''} connected`
          }
        />
      )}

      <AuctionDialogs view={p.view} pending={p.pending} run={p.run} dialog={p.dialog} setDialog={p.setDialog} correctInitial={p.correctInitial} />
    </div>
  )
}

// ───────────────────────── pieces ─────────────────────────
function Toggle({ on, disabled, onClick, children, testId, warn = false }: { on: boolean; disabled: boolean; onClick: () => void; children: ReactNode; testId: string; warn?: boolean }) {
  return (
    <button
      data-testid={testId}
      className={`relative h-10 rounded-lg text-[14px] font-bold disabled:opacity-35 ${on ? 'bg-brand text-white' : 'border border-line bg-white text-navy'}`}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
      {warn && <span className="absolute right-2 top-2 h-2.5 w-2.5 rounded-full bg-warn ring-2 ring-white" aria-label="Sound blocked" />}
    </button>
  )
}

function Dot({ ok, warn, label }: { ok: boolean; warn: boolean; label: string }) {
  return (
    <span className="flex flex-col items-center px-0.5" title={label}>
      <span className={`h-2.5 w-2.5 rounded-full ${ok ? 'bg-ok' : warn ? 'bg-warn' : 'bg-bad'}`} />
      <span className="mt-0.5 text-[9px] font-bold uppercase tracking-wider text-ink-faint">{label}</span>
    </span>
  )
}

function Banner({ tone, children }: { tone: 'bad' | 'warn'; children: ReactNode }) {
  return (
    <div className={`shrink-0 px-3 py-1.5 text-xs font-bold ${tone === 'bad' ? 'bg-bad text-white' : 'bg-warn text-white'}`} role="alert">
      {children}
    </div>
  )
}

function Key({ children, onClick, disabled, fn = false, label }: { children: ReactNode; onClick: () => void; disabled: boolean; fn?: boolean; label?: string }) {
  return (
    <button
      aria-label={label}
      className={`rounded-xl text-[clamp(1.4rem,7vw,2rem)] font-semibold shadow-[0_1px_0_rgba(0,29,74,0.12)] transition-colors disabled:opacity-40 ${
        fn ? 'bg-subtle-2 text-navy active:bg-line' : 'bg-white text-navy active:bg-brand-100'
      }`}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function OpKey({
  children,
  onClick,
  disabled,
  armed,
  correction = false,
  sending,
  label,
  testId,
  small = false,
}: {
  correction?: boolean
  children: ReactNode
  onClick: () => void
  disabled: boolean
  armed: boolean
  sending: boolean
  label: string
  testId: string
  small?: boolean
}) {
  return (
    <button
      aria-label={armed ? `${label} — confirm` : label}
      data-testid={testId}
      className={`row-span-2 flex flex-col items-center justify-center rounded-xl font-bold text-white shadow-[0_2px_0_rgba(0,29,74,0.2)] disabled:opacity-40 ${
        correction ? 'bg-warn' : armed ? 'bg-ok active:bg-green-700' : 'bg-brand active:bg-brand-600'
      }`}
      disabled={disabled}
      onClick={onClick}
    >
      {armed ? (
        <>
          <span className="text-[clamp(1.8rem,9vw,2.6rem)] leading-none">{sending ? '…' : '✓'}</span>
          <span className="mt-1 text-xs font-bold uppercase tracking-[0.16em]">{correction ? 'Correct' : 'Send'}</span>
        </>
      ) : (
        <span className={small ? 'text-[clamp(1.2rem,6vw,1.6rem)] tracking-[0.08em]' : 'text-[clamp(2.2rem,11vw,3rem)] leading-none'}>{children}</span>
      )}
    </button>
  )
}

function Act({
  children,
  onClick,
  disabled,
  tone,
  wide = false,
}: {
  children: ReactNode
  onClick: () => void
  disabled: boolean
  tone: 'brand' | 'warn' | 'navy' | 'navyOutline' | 'ok' | 'ghost'
  wide?: boolean
}) {
  const cls = {
    brand: 'bg-brand text-white',
    warn: 'border-2 border-warn text-warn bg-white',
    navy: 'bg-navy text-white',
    navyOutline: 'border-2 border-navy text-navy bg-white',
    ok: 'bg-ok text-white',
    ghost: 'border border-line bg-white text-navy',
  }[tone]
  return (
    <button
      className={`h-12 whitespace-nowrap rounded-lg px-0.5 text-[clamp(12px,3.6vw,15px)] font-bold leading-tight tracking-tight disabled:opacity-35 ${cls} ${wide ? 'col-span-4 !text-lg' : ''}`}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function VolumeRow({ view, run, enabled, audioText }: { view: StaffView; run: (c: Command) => Promise<boolean>; enabled: boolean; audioText: { text: string; tone: string } }) {
  const [vol, setVol] = useVolume(view, run, enabled)
  return (
    <div className="border-t border-line px-4 py-3">
      <label className="flex items-center gap-3">
        <span className="text-[16px] font-semibold text-navy">Music volume</span>
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
        <span className="w-8 text-right font-semibold tabular-nums text-navy">{vol}</span>
      </label>
      <div className={`mt-1 text-sm font-semibold ${audioText.tone}`}>{audioText.text}</div>
    </div>
  )
}

function PairBox({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const { user } = useUser()
  const [code, setCode] = useState('')
  const [res, setRes] = useState<{ ok: boolean; text: string } | null>(null)
  return (
    <div className="mt-2">
      <div className="flex gap-2">
        <input
          className="w-28 rounded-md border border-line bg-white px-2 py-2 text-center text-base font-bold uppercase tracking-[0.25em] text-navy"
          placeholder="CODE"
          aria-label="Room screen pairing code"
          value={code}
          maxLength={7}
          autoCapitalize="characters"
          autoComplete="off"
          onChange={(e) => setCode(e.target.value.toUpperCase())}
        />
        <button
          className="btn-primary flex-1 py-2 text-sm"
          disabled={disabled || code.replace(/\s/g, '').length < 6}
          onClick={async () => {
            setRes(null)
            try {
              await server.staff.approvePairing(code, sessionId, 'Auction room screen', user)
              setRes({ ok: true, text: 'Screen paired.' })
              setCode('')
            } catch (e) {
              setRes({ ok: false, text: e instanceof Error ? e.message : String(e) })
            }
          }}
        >
          Pair room screen
        </button>
      </div>
      <div className="mt-1 text-xs text-ink-muted">Open /auction/pair on the screen and type the code it shows.</div>
      {res && <div className={`mt-1 text-sm font-semibold ${res.ok ? 'text-ok' : 'text-bad'}`}>{res.text}</div>}
    </div>
  )
}

function MenuSheet(
  p: Props & { can: (t: Command['type']) => boolean; onClose: () => void; screenText: string },
) {
  const { logout, user: me } = useAuth()
  const s = p.view.state
  const recent = p.view.bids.slice(0, 5)
  const item = 'flex w-full items-center justify-between px-4 py-3.5 text-left text-[16px] font-semibold text-navy disabled:opacity-35'
  const act = (fn: () => void) => () => {
    p.onClose()
    fn()
  }
  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end bg-black/50" onClick={p.onClose} role="presentation">
      <div
        className="max-h-[88dvh] overflow-y-auto rounded-t-2xl bg-white pb-[env(safe-area-inset-bottom)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Console menu"
      >
        <div className="mx-auto mt-2 h-1.5 w-10 rounded-full bg-line" />
        <div className="divide-y divide-line">
          <button className={item} disabled={!p.can('UNDO')} onClick={act(() => p.setDialog('UNDO'))}>
            Undo last bid… <span className="text-sm text-ink-muted">{formatCents(s.currentBidCents)}</span>
          </button>
          <button className={item} disabled={!p.can('CORRECT')} onClick={act(() => p.setDialog('CORRECT'))}>
            Correct last bid…
          </button>
          <button
            className={item}
            disabled={!p.can('SET_OVERLAY')}
            onClick={act(() => void p.run({ type: 'SET_OVERLAY', hidden: !s.overlayHidden }))}
          >
            {s.overlayHidden ? 'Show room screen stickers' : 'Hide room screen stickers'}
          </button>
          <button className={`${item} text-bad`} disabled={!p.can('END')} onClick={act(() => p.setDialog('END'))}>
            End auction without result…
          </button>
        </div>

        <VolumeRow view={p.view} run={p.run} enabled={p.controlsEnabled} audioText={AUDIO_TEXT[screenAudio(p.view, p.now)]} />
        <div className="bg-subtle px-4 py-3">
          <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-ink-faint">Room screen</div>
          <div className="text-sm font-semibold text-navy">{p.screenText}</div>
          <PairBox sessionId={p.view.session.id} disabled={p.cloud === 'OFFLINE'} />
          <div className="mt-3 text-[11px] font-bold uppercase tracking-[0.16em] text-ink-faint">Recent bids</div>
          {recent.length === 0 ? (
            <div className="text-sm text-ink-muted">No bids yet</div>
          ) : (
            <ul className="mt-1 space-y-0.5 text-sm tabular-nums">
              {recent.map((b) => (
                <li key={b.id} className={`flex justify-between ${b.status === 'ACTIVE' ? 'text-navy' : 'text-ink-faint line-through'}`}>
                  <span>#{b.seq}</span>
                  <span className="font-semibold">{formatCents(b.amountCents)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="divide-y divide-line">
          {p.lease.hasControl && (
            <button className={item} onClick={act(() => void p.lease.release())}>
              Release operator control
            </button>
          )}
          {me?.role === 'admin' && (
            <Link className={item} to="/auction/media" onClick={p.onClose}>
              Room media (image &amp; music)
            </Link>
          )}
          <Link className={item} to="/auction/reports" onClick={p.onClose}>
            Reports
          </Link>
          <Link className={item} to="/auction/sessions" onClick={p.onClose}>
            Sessions
          </Link>
          <button className={item} onClick={act(() => setLayoutPref('desktop'))}>
            Switch to desktop layout
          </button>
          <button className={`${item} text-bad`} onClick={() => void logout()}>
            Sign out
          </button>
          <button className={`${item} justify-center text-ink-muted`} onClick={p.onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
