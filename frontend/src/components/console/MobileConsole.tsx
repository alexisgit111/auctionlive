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
import { AUDIO_SHORT, AUDIO_TEXT, audioScreensNote, AuctionDialogs, deviceHealth, LeasePanel, pairedAt, ScreenSwitchBanner, screenAudio, useDisplaysHealth, useVolume, type Dialog } from './panels'

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
  // Typing works whenever this phone has control; whether a bid is accepted is decided on send.
  const keysOn = (p.canBid || p.controlsEnabled) && !p.pending
  const pub = derivePublicStatus(s)
  const displays = useDisplaysHealth(p.view, p.now)
  const audio = screenAudio(p.view, p.now)

  const [input, setInput] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [sheet, setSheet] = useState(false)
  const [flash, setFlash] = useState(0)
  const [sending, setSending] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  useEffect(() => {
    if (done === null) return
    const t = setTimeout(() => setDone(null), 1800)
    return () => clearTimeout(t)
  }, [done])

  const press = (k: string) => {
    if (!keysOn) return
    setMsg(null)
    setDone(null)
    setInput((v) => typeKey(v, k))
    buzz(5)
  }

  const finish = (ok: boolean, text: string) => {
    if (!ok) return
    setInput('')
    setFlash((f) => f + 1)
    setDone(text)
    buzz(30)
  }

  /** Calculator: one tap does it — no confirmations. */
  const op = async (compute: () => CalcResult) => {
    if (!keysOn || sending) return
    const r = compute()
    if (!r.ok) {
      setMsg(r.message)
      buzz([20, 40, 20])
      return
    }
    setMsg(null)
    setSending(true)
    try {
      if (r.kind === 'HIDE') {
        finish(s.priceHidden ? true : await p.run({ type: 'HIDE_PRICE' }), 'Price hidden on the room screen')
      } else if (r.kind === 'SHOW') {
        finish(s.priceHidden ? await p.run({ type: 'SHOW_PRICE' }) : true, `Showing ${formatCents(r.target)}`)
      } else if (r.kind === 'CORRECT') {
        if (!allowed.has('CORRECT') || !s.currentBidId) return setMsg('Nothing to correct right now')
        const ok = await p.run({ type: 'CORRECT', bidId: s.currentBidId, amountCents: r.target.toString(), reason: 'Set on console' })
        finish(ok, `Set to ${formatCents(r.target)}`)
      } else {
        if (!p.canBid) return setMsg(p.bidDisabledReason ?? 'Bidding is closed')
        finish(await p.submitBid(r.target), `Sent ${formatCents(r.target)}`)
      }
    } finally {
      setSending(false)
    }
  }

  const plus = () => op(() => computeTarget('ADD', input, current, defInc))
  const set = () => op(() => computeTarget('SET', input, current, defInc))
  const undo = async () => {
    if (!s.currentBidId || sending) return
    setSending(true)
    try {
      finish(await p.run({ type: 'UNDO', bidId: s.currentBidId, reason: 'Undone on console' }), 'Last bid undone')
    } finally {
      setSending(false)
    }
  }

  // 1st / 2nd call need a second tap (confirm) within 4 s
  const [confirmCall, setConfirmCall] = useState<1 | 2 | null>(null)
  useEffect(() => {
    if (confirmCall === null) return
    const t = setTimeout(() => setConfirmCall(null), 4000)
    return () => clearTimeout(t)
  }, [confirmCall])
  const tapCall = (n: 1 | 2) => {
    if (confirmCall !== n) {
      setConfirmCall(n)
      buzz(10)
      return
    }
    setConfirmCall(null)
    void p.run({ type: n === 1 ? 'FIRST_CALL' : 'SECOND_CALL' }).then((ok) => ok && buzz(30))
  }

  const statusDot =
    s.call === 2 ? 'bg-bad' : s.call === 1 ? 'bg-warn' : pub === 'SOLD' ? 'bg-ok' : pub === 'ON_THE_MARKET' ? 'bg-brand' : pub === 'PAUSED' ? 'bg-warn' : pub === 'LIVE' ? 'bg-ok' : 'bg-ink-faint'
  const statusText =
    s.call === 1 && (pub === 'LIVE' || pub === 'ON_THE_MARKET')
      ? '1st call'
      : s.call === 2 && (pub === 'LIVE' || pub === 'ON_THE_MARKET')
        ? '2nd call'
        : s.withdrawnSold && pub === 'SOLD'
          ? 'Withdrawn & sold'
          : PUBLIC_LABEL[pub]

  return (
    <div className="m-bg fixed inset-0 z-30 flex touch-manipulation select-none justify-center" data-testid="mobile-console">
      {/* phone: full width · tablet: a centred column sized in container units */}
      <div className="flex h-full w-full max-w-[720px] flex-col gap-2 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-[max(0.5rem,env(safe-area-inset-top))] [container-type:inline-size]">
        {/* ── top bar ── */}
        <div className="m-panel flex h-12 shrink-0 items-center gap-1.5 pl-1 pr-1.5 md:h-14">
          <select
            aria-label="Session"
            className="min-w-0 flex-1 truncate rounded-xl border-0 bg-transparent px-2 py-1.5 text-[15px] font-semibold text-m-ink focus:ring-0 md:text-lg"
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
          <button className="m-key flex h-9 w-9 items-center justify-center !rounded-full" aria-label="Menu" data-testid="mobile-menu" onClick={() => setSheet(true)}>
            <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M5 8h14M5 16h14" />
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
          <button className="shrink-0 rounded-2xl bg-bad px-3 py-2 text-left text-sm font-semibold text-white shadow-lg shadow-bad/20" onClick={p.clearError}>
            {p.error.message} <span className="opacity-70">· tap to dismiss</span>
          </button>
        )}

        <ScreenSwitchBanner view={p.view} now={p.now} cloudOk={p.cloud !== 'OFFLINE'} compact />

        {/* ── LCD display ── */}
        <section className="m-lcd shrink-0 px-4 pb-2 pt-2.5">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-m-ink-soft md:text-sm">
            <span className={`h-2 w-2 shrink-0 rounded-full ${statusDot}`} />
            <span className="text-m-ink" data-testid="mobile-status">
              {statusText}
            </span>
            {s.overlayHidden && <span className="text-m-ink-faint">· Stickers off</span>}
            <span className="ml-auto text-m-ink-faint">
              {s.bidCount} bid{s.bidCount === 1 ? '' : 's'}
            </span>
          </div>
          <div
            key={flash}
            data-testid="mobile-current"
            className={`mt-1 rounded-lg text-right text-[clamp(2.5rem,13cqw,4.8rem)] font-light leading-none tabular-nums tracking-tight text-m-ink ${flash ? 'bid-flash' : ''}`}
          >
            {formatCents(s.currentBidCents) === '—' ? 'No bids' : formatCents(s.currentBidCents)}
          </div>
          {(s.priceHidden || s.sessionStatus === 'NOT_STARTED') && s.currentBidCents && (
            <div className="mt-1 text-right text-[11px] font-semibold uppercase tracking-[0.14em] text-warn" data-testid="mobile-price-hidden">
              Hidden on room screen
            </div>
          )}

          <div className="mt-2 flex min-h-[40px] items-center gap-3 border-t border-black/[0.06] pt-2" aria-live="polite">
            <div className="min-w-0 flex-1 text-[12px] leading-tight md:text-sm">
              {msg ? (
                <span className="font-semibold text-bad">{msg}</span>
              ) : done !== null ? (
                <span className="text-[15px] font-semibold text-ok md:text-lg" data-testid="mobile-sent">
                  ✓ {done}
                </span>
              ) : !p.canBid ? (
                <span className="text-m-ink-faint">{p.bidDisabledReason ?? 'Bidding is closed'}</span>
              ) : (
                <span className="text-m-ink-faint">
                  <b className="font-semibold text-m-ink-soft">1K +</b> add · <b className="font-semibold text-m-ink-soft">1.25M SET</b> set · <b className="font-semibold text-m-ink-soft">0 SET</b> hide
                </span>
              )}
            </div>
            <div className="shrink-0 text-right text-[28px] font-medium tabular-nums leading-none text-m-ink" data-testid="mobile-input">
              {input || <span className="text-m-ink-faint/50">0</span>}
            </div>
          </div>
        </section>

        {/* ── auction buttons ── */}
        {!p.lease.hasControl && (
          <div className="m-panel shrink-0 p-2">
            <LeasePanel
              lease={p.view.lease}
              hasControl={p.lease.hasControl}
              error={p.lease.error}
              onAcquire={p.lease.acquire}
              onRelease={p.lease.release}
              onTakeover={p.lease.takeover}
              now={p.now}
              flat
            />
          </div>
        )}

        {p.lease.hasControl && (
          <div className="m-panel grid shrink-0 grid-cols-4 gap-1.5 p-1.5" data-testid="auction-buttons">
            {s.sessionStatus === 'NOT_STARTED' ? (
              <div className="col-span-4">
                <Act dark wide disabled={!can('START')} onClick={() => void p.run({ type: 'START' })}>
                  Start auction
                </Act>
              </div>
            ) : s.sessionStatus === 'ENDED' ? (
              <div className="col-span-4">
                <Act dark wide disabled={!can('REOPEN')} onClick={() => void p.run({ type: 'REOPEN', reason: 'Reopened on console' })}>
                  {s.saleStatus === 'SOLD' ? 'Undo SOLD — reopen' : s.saleStatus === 'PASSED_IN' ? 'Undo PASSED IN — reopen' : 'Reopen auction'}
                </Act>
              </div>
            ) : (
              <>
                {s.saleStatus === 'ON_THE_MARKET' ? (
                  <Act label="Off the market" led="bg-brand" disabled={!can('OFF_MARKET')} onClick={() => void p.run({ type: 'OFF_MARKET' })}>
                    Off mkt
                  </Act>
                ) : (
                  <Act label="On the market" led="off" disabled={!can('ON_THE_MARKET')} onClick={() => void p.run({ type: 'ON_THE_MARKET' })}>
                    Market
                  </Act>
                )}
                <CallButton n={1} active={s.call === 1} confirming={confirmCall === 1} disabled={!can('FIRST_CALL')} onTap={() => tapCall(1)} />
                <CallButton n={2} active={s.call === 2} confirming={confirmCall === 2} disabled={!can('SECOND_CALL')} onTap={() => tapCall(2)} />
                <Act dark disabled={!can('SOLD')} onClick={() => void p.run({ type: 'SOLD' })}>
                  Sold
                </Act>

                {s.sessionStatus === 'PAUSED' ? (
                  <Act led="bg-warn" disabled={!can('RESUME')} onClick={() => void p.run({ type: 'RESUME' })}>
                    Resume
                  </Act>
                ) : (
                  <Act disabled={!can('PAUSE')} onClick={() => void p.run({ type: 'PAUSE' })}>
                    Pause
                  </Act>
                )}
                <Act label="Withdrawn & Sold" disabled={!can('WITHDRAWN_SOLD')} onClick={() => void p.run({ type: 'WITHDRAWN_SOLD' })}>
                  W/D Sold
                </Act>
                <Act label="Pass in" disabled={!can('PASSED_IN')} onClick={() => void p.run({ type: 'PASSED_IN' })}>
                  Pass in
                </Act>
                <Act
                  label={s.overlayHidden ? 'Show stickers' : 'Remove'}
                  disabled={!can('SET_OVERLAY')}
                  onClick={() => void p.run({ type: 'SET_OVERLAY', hidden: !s.overlayHidden })}
                >
                  {s.overlayHidden ? 'Show' : 'Clear'}
                </Act>
              </>
            )}

            {/* room screen media + end */}
            <div className="col-span-4 grid grid-cols-3 gap-1.5">
              <Toggle on={!!s.welcomeOn} disabled={!can('SET_WELCOME')} onClick={() => void p.run({ type: 'SET_WELCOME', on: !s.welcomeOn })} testId="m-toggle-welcome">
                Welcome
              </Toggle>
              <Toggle
                on={!!s.musicOn}
                disabled={!can('SET_MUSIC')}
                onClick={() => void p.run({ type: 'SET_MUSIC', on: !s.musicOn })}
                testId="m-toggle-music"
                warn={(s.welcomeOn || s.musicOn) && (audio === 'blocked' || audio === 'error')}
              >
                Music
              </Toggle>
              <button data-testid="m-end" className="m-key h-10 text-[14px] font-semibold !text-bad md:h-12 md:text-base" disabled={!can('END')} onClick={() => void p.run({ type: 'END' })}>
                End
              </button>
            </div>
          </div>
        )}
        {(s.welcomeOn || s.musicOn) && (audio === 'blocked' || audio === 'error') && (
          <div className="-mt-1 shrink-0 px-3 text-center text-[12px] font-semibold text-warn">{AUDIO_TEXT[audio].text}{audioScreensNote(p.view, p.now, audio)}</div>
        )}

        {/* ── keypad ── */}
        <div className="m-panel grid min-h-0 flex-1 grid-cols-4 grid-rows-5 gap-1.5 p-1.5">
          <Key onClick={() => press('00')} disabled={!keysOn}>
            00
          </Key>
          <Key onClick={() => press('K')} disabled={!keysOn}>
            K
          </Key>
          <Key onClick={() => press('M')} disabled={!keysOn}>
            M
          </Key>
          <Key dark onClick={() => press('C')} disabled={!keysOn} label="Clear">
            C
          </Key>
          <Key onClick={() => press('7')} disabled={!keysOn}>7</Key>
          <Key onClick={() => press('8')} disabled={!keysOn}>8</Key>
          <Key onClick={() => press('9')} disabled={!keysOn}>9</Key>
          <OpKey onClick={() => void plus()} disabled={!keysOn || sending} label="Plus" testId="key-plus">
            +
          </OpKey>
          <Key onClick={() => press('4')} disabled={!keysOn}>4</Key>
          <Key onClick={() => press('5')} disabled={!keysOn}>5</Key>
          <Key onClick={() => press('6')} disabled={!keysOn}>6</Key>
          <Key onClick={() => press('1')} disabled={!keysOn}>1</Key>
          <Key onClick={() => press('2')} disabled={!keysOn}>2</Key>
          <Key onClick={() => press('3')} disabled={!keysOn}>3</Key>
          <OpKey onClick={() => void set()} disabled={!keysOn || sending} label="Set" testId="key-set" small>
            SET
          </OpKey>
          <Key onClick={() => press('0')} disabled={!keysOn}>0</Key>
          <button
            data-testid="key-undo"
            aria-label="Undo last bid"
            className="m-key flex items-center justify-center"
            disabled={!can('UNDO') || sending}
            onClick={() => void undo()}
          >
            <svg viewBox="0 0 24 24" className="h-[clamp(1.4rem,6.5cqw,2rem)] w-[clamp(1.4rem,6.5cqw,2rem)]" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 14 4 9l5-5" />
              <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
            </svg>
          </button>
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
    </div>
  )
}

// ───────────────────────── pieces ─────────────────────────
/** Small indicator light, like the mode lamp on a desk calculator. */
function Led({ color }: { color: string }) {
  return color === 'off' ? (
    <span className="absolute right-1.5 top-1.5 h-[7px] w-[7px] rounded-full bg-black/10 shadow-[inset_0_1px_1px_rgba(0,0,0,0.15)]" />
  ) : (
    <span className={`absolute right-1.5 top-1.5 h-[7px] w-[7px] rounded-full ${color} ring-2 ring-white/90 shadow-[0_0_8px_rgba(0,161,233,0.45)]`} />
  )
}

function Toggle({ on, disabled, onClick, children, testId, warn = false }: { on: boolean; disabled: boolean; onClick: () => void; children: ReactNode; testId: string; warn?: boolean }) {
  return (
    <button
      data-testid={testId}
      aria-pressed={on}
      className="m-key relative h-10 text-[14px] font-semibold md:h-12 md:text-base"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
      <Led color={warn ? 'bg-warn' : on ? 'bg-brand' : 'off'} />
    </button>
  )
}

function Dot({ ok, warn, label }: { ok: boolean; warn: boolean; label: string }) {
  return (
    <span className="flex flex-col items-center px-0.5" title={label} aria-label={`${label}: ${ok ? 'ok' : warn ? 'slow' : 'offline'}`}>
      <span className={`h-2 w-2 rounded-full ${ok ? 'bg-ok' : warn ? 'bg-warn' : 'bg-bad'}`} />
      <span className="mt-0.5 text-[8px] font-semibold uppercase tracking-wider text-m-ink-faint">{label}</span>
    </span>
  )
}

function Banner({ tone, children }: { tone: 'bad' | 'warn'; children: ReactNode }) {
  return (
    <div className={`shrink-0 rounded-2xl px-3 py-2 text-xs font-semibold text-white shadow-lg ${tone === 'bad' ? 'bg-bad shadow-bad/20' : 'bg-warn shadow-warn/20'}`} role="alert">
      {children}
    </div>
  )
}

function Key({ children, onClick, disabled, dark = false, label }: { children: ReactNode; onClick: () => void; disabled: boolean; dark?: boolean; label?: string }) {
  return (
    <button
      aria-label={label}
      className={`${dark ? 'm-key-dark' : 'm-key'} text-[clamp(1.4rem,7cqw,2rem)] font-medium`}
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
  label,
  testId,
  small = false,
}: {
  children: ReactNode
  onClick: () => void
  disabled: boolean
  label: string
  testId: string
  small?: boolean
}) {
  return (
    <button aria-label={label} data-testid={testId} className="m-key-dark row-span-2 flex flex-col items-center justify-center" disabled={disabled} onClick={onClick}>
      <span className={small ? 'text-[clamp(1.1rem,5.5cqw,1.5rem)] font-semibold tracking-[0.1em]' : 'text-[clamp(2.2rem,11cqw,3rem)] font-light leading-none'}>{children}</span>
    </button>
  )
}

/** Auction action button. `label` keeps the full name for screen readers when the visible text is shortened. */
function Act({
  children,
  onClick,
  disabled,
  dark = false,
  wide = false,
  led,
  label,
}: {
  children: ReactNode
  onClick: () => void
  disabled: boolean
  dark?: boolean
  wide?: boolean
  led?: string
  label?: string
}) {
  return (
    <button
      aria-label={label}
      className={`${dark ? 'm-key-dark' : 'm-key'} relative flex items-center justify-center px-1 text-center font-semibold leading-[1.1] ${
        wide ? 'h-12 w-full text-lg md:h-16 md:text-xl' : 'h-11 text-[clamp(13px,3.7cqw,17px)] md:h-14'
      }`}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
      {led && <Led color={led} />}
    </button>
  )
}

/** 1st / 2nd call: first tap arms (shows "Confirm"), second tap within 4 s sends. */
function CallButton({ n, active, confirming, disabled, onTap }: { n: 1 | 2; active: boolean; confirming: boolean; disabled: boolean; onTap: () => void }) {
  const label = n === 1 ? '1st Call' : '2nd Call'
  const short = n === 1 ? '1st' : '2nd'
  return (
    <button
      data-testid={`call-${n}`}
      aria-label={confirming ? `Confirm ${label}` : label}
      className={`${confirming ? 'm-key-dark' : 'm-key'} relative flex h-11 flex-col items-center justify-center px-1 font-semibold leading-[1.1] md:h-14`}
      disabled={disabled}
      onClick={onTap}
    >
      {confirming ? (
        <>
          <span className="text-[clamp(12px,3.4cqw,16px)] md:text-lg">Confirm</span>
          <span className="text-[10px] font-medium opacity-70">{short} ✓</span>
        </>
      ) : (
        <span className="text-[clamp(13px,3.7cqw,17px)] md:text-lg">{short}</span>
      )}
      {!confirming && <Led color={active ? (n === 1 ? 'bg-warn' : 'bg-bad') : 'off'} />}
    </button>
  )
}

function VolumeRow({ view, run, enabled, audioText }: { view: StaffView; run: (c: Command) => Promise<boolean>; enabled: boolean; audioText: { text: string; tone: string } }) {
  const [vol, setVol] = useVolume(view, run, enabled)
  return (
    <div className="rounded-2xl bg-white px-4 py-3 shadow-sm">
      <label className="flex items-center gap-3">
        <span className="text-[16px] font-medium text-m-ink">Music volume</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={vol}
          disabled={!enabled}
          aria-label="Room screen volume"
          className="flex-1 accent-m-key"
          onChange={(e) => setVol(Number(e.target.value))}
        />
        <span className="w-8 text-right font-semibold tabular-nums text-m-ink">{vol}</span>
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
          className="w-28 rounded-xl border border-black/10 bg-[#f6f7f9] px-2 py-2 text-center text-base font-bold uppercase tracking-[0.25em] text-m-ink shadow-[inset_0_1px_3px_rgba(15,23,42,0.08)]"
          placeholder="CODE"
          aria-label="Room screen pairing code"
          value={code}
          maxLength={7}
          autoCapitalize="characters"
          autoComplete="off"
          onChange={(e) => setCode(e.target.value.toUpperCase())}
        />
        <button
          className="m-key-dark flex-1 py-2 text-sm font-semibold"
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
  const item = 'flex w-full items-center justify-between px-4 py-3 text-left text-[16px] font-medium text-m-ink active:bg-black/[0.03] disabled:opacity-35'
  const act = (fn: () => void) => () => {
    p.onClose()
    fn()
  }
  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end bg-black/25 backdrop-blur-[2px]" onClick={p.onClose} role="presentation">
      <div
        className="mx-auto max-h-[88dvh] w-full max-w-[720px] space-y-2 overflow-y-auto rounded-t-[28px] border border-white/70 bg-[#f1f3f5]/90 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-[0_-10px_40px_-10px_rgba(15,23,42,0.3)] backdrop-blur-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Console menu"
      >
        <div className="mx-auto mb-1 mt-2 h-1.5 w-10 rounded-full bg-black/15" />
        <div className="divide-y divide-black/[0.06] overflow-hidden rounded-2xl bg-white shadow-sm">
          <button
            className={item}
            disabled={!p.can('UNDO') || !s.currentBidId}
            onClick={act(() => void p.run({ type: 'UNDO', bidId: s.currentBidId!, reason: 'Undone on console' }))}
          >
            Undo last bid <span className="text-sm text-m-ink-faint">{formatCents(s.currentBidCents)}</span>
          </button>
          <button className={item} disabled={!p.can('CORRECT')} onClick={act(() => p.setDialog('CORRECT'))}>
            Correct last bid…
          </button>
          <button
            className={item}
            disabled={!p.can(s.priceHidden ? 'SHOW_PRICE' : 'HIDE_PRICE')}
            onClick={act(() => void p.run({ type: s.priceHidden ? 'SHOW_PRICE' : 'HIDE_PRICE' }))}
          >
            {s.priceHidden ? 'Show the price on the room screen' : 'Hide the price on the room screen'}
          </button>
          <button
            className={item}
            disabled={!p.can('SET_OVERLAY')}
            onClick={act(() => void p.run({ type: 'SET_OVERLAY', hidden: !s.overlayHidden }))}
          >
            {s.overlayHidden ? 'Show room screen stickers' : 'Hide room screen stickers'}
          </button>
        </div>

        <VolumeRow view={p.view} run={p.run} enabled={p.controlsEnabled} audioText={{ ...AUDIO_TEXT[screenAudio(p.view, p.now)], text: AUDIO_TEXT[screenAudio(p.view, p.now)].text + audioScreensNote(p.view, p.now, screenAudio(p.view, p.now)) }} />
        <div className="rounded-2xl bg-white px-4 py-3 shadow-sm">
          <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-ink-faint">Room screen</div>
          <div className="text-sm font-semibold text-m-ink">{p.screenText}</div>
          {p.view.devices.some((d) => !d.revokedAt) && (
            <ul className="mt-1 space-y-0.5 text-[13px]" data-testid="m-screens">
              {p.view.devices.filter((d) => !d.revokedAt).map((d) => {
                const h = deviceHealth(d, s.stateVersion, p.now)
                const a = h.connected ? AUDIO_SHORT[d.audioStatus ?? 'off'] : null
                return (
                  <li key={d.id} className="flex flex-wrap items-center gap-x-2">
                    <span className={`h-2 w-2 rounded-full ${h.connected ? 'bg-ok' : 'bg-bad'}`} />
                    <span className="font-medium text-m-ink">{d.label}</span>
                    {d.approvedAt && <span className="text-m-ink-faint">{pairedAt(d.approvedAt)}</span>}
                    {a && <span className={`font-semibold ${a.tone}`}>{a.text}</span>}
                  </li>
                )
              })}
            </ul>
          )}
          <PairBox sessionId={p.view.session.id} disabled={p.cloud === 'OFFLINE'} />
          <div className="mt-3 text-[11px] font-bold uppercase tracking-[0.16em] text-ink-faint">Recent bids</div>
          {recent.length === 0 ? (
            <div className="text-sm text-ink-muted">No bids yet</div>
          ) : (
            <ul className="mt-1 space-y-0.5 text-sm tabular-nums">
              {recent.map((b) => (
                <li key={b.id} className={`flex justify-between ${b.status === 'ACTIVE' ? 'text-m-ink' : 'text-m-ink-faint line-through'}`}>
                  <span>#{b.seq}</span>
                  <span className="font-semibold">{formatCents(b.amountCents)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="divide-y divide-black/[0.06] overflow-hidden rounded-2xl bg-white shadow-sm">
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
          </div>
        <button className={`${item} justify-center rounded-2xl bg-white font-semibold shadow-sm`} onClick={p.onClose}>
          Close
        </button>
      </div>
    </div>
  )
}
