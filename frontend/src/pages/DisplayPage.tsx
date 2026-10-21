import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { loadCredential, saveCredential, useDisplaySync } from '../app/displaySync'
import { BrandLogo, PersonPhoto, PropertyImage } from '../components/brand'
import { BathIcon, BedIcon, FloorIcon, GarageIcon, LandIcon } from '../components/display/icons'
import type { DisplayOverlay, PublicDisplayState, PublicStatus, Salesperson } from '../engine/types'

/**
 * Independent Room Display — 16:9, white-based, readable from distance.
 * Renders ONLY the whitelisted public payload. All sizes are in container
 * units (cqw) so the layout scales identically on any screen.
 */

const FOOTER_TEXT = (import.meta.env.VITE_BRAND_WEBSITE as string | undefined) ?? 'goldenlinks.co.nz'

export function DisplayPage() {
  const { sessionId } = useParams()
  const nav = useNavigate()
  const [cred, setCred] = useState(loadCredential)
  const { state, overlay, unpaired } = useDisplaySync(cred)

  useEffect(() => {
    if (unpaired) saveCredential(null)
  }, [unpaired])

  // Staff moved this screen to another session → follow it.
  useEffect(() => {
    if (cred && state && state.sessionId !== cred.sessionId) {
      const next = { ...cred, sessionId: state.sessionId }
      saveCredential(next)
      setCred(next)
    }
  }, [cred, state])

  // Keep the address bar on the session this screen is paired with.
  useEffect(() => {
    if (cred && sessionId !== cred.sessionId) nav(`/auction/display/${cred.sessionId}`, { replace: true })
  }, [cred, sessionId, nav])

  if (!cred || unpaired) return <NotPaired revoked={unpaired} />
  return <Stage state={state} overlay={overlay} />
}

/** Letterboxed 16:9 stage that fills the viewport. */
export function StageFrame({ children, idleCursor = false }: { children: ReactNode; idleCursor?: boolean }) {
  return (
    <div
      className={`flex h-screen w-screen items-center bg-[#E9EDF2] ${idleCursor ? 'cursor-none' : ''}`}
      onDoubleClick={() => void document.documentElement.requestFullscreen?.().catch(() => {})}
    >
      <div className="relative mx-auto aspect-video w-[min(100vw,177.78vh)] overflow-hidden bg-white [container-type:size]" data-testid="display-stage">
        {children}
      </div>
    </div>
  )
}

function useIdleCursor() {
  const [idle, setIdle] = useState(false)
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>
    const wake = () => {
      setIdle(false)
      clearTimeout(t)
      t = setTimeout(() => setIdle(true), 3000)
    }
    wake()
    window.addEventListener('mousemove', wake)
    return () => {
      window.removeEventListener('mousemove', wake)
      clearTimeout(t)
    }
  }, [])
  return idle
}

/** True for a few seconds after someone moves the mouse / touches the screen (never on its own). */
function useRecentPointer(ms = 4000) {
  const [on, setOn] = useState(false)
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>
    const wake = () => {
      setOn(true)
      clearTimeout(t)
      t = setTimeout(() => setOn(false), ms)
    }
    window.addEventListener('mousemove', wake)
    window.addEventListener('touchstart', wake)
    return () => {
      window.removeEventListener('mousemove', wake)
      window.removeEventListener('touchstart', wake)
      clearTimeout(t)
    }
  }, [ms])
  return on
}

/** Small status line under the bid (right column). */
const STATUS_LINE: Record<PublicStatus, { text: string; cls: string }> = {
  NOT_STARTED: { text: 'Auction starting soon', cls: 'bg-subtle text-navy' },
  LIVE: { text: 'Auction live', cls: 'bg-navy text-white' },
  ON_THE_MARKET: { text: 'On the market', cls: 'bg-brand text-white' },
  PAUSED: { text: 'Auction paused', cls: 'bg-warn text-white' },
  SOLD: { text: 'Sold', cls: 'bg-brand text-white' },
  PASSED_IN: { text: 'Passed in', cls: 'bg-navy text-white' },
  ENDED: { text: 'Auction closed', cls: 'bg-subtle text-navy' },
}

/** Big circle over the photo, only for statuses the room must notice. */
const CIRCLE: Partial<Record<PublicStatus, { lines: string[]; cls: string }>> = {
  ON_THE_MARKET: { lines: ['On the', 'Market'], cls: 'bg-brand text-white' },
  SOLD: { lines: ['SOLD'], cls: 'bg-brand text-white' },
  PASSED_IN: { lines: ['Passed', 'In'], cls: 'bg-navy text-white' },
  PAUSED: { lines: ['Auction', 'Paused'], cls: 'bg-navy text-white' },
}

function Feature({ icon, value, suffix }: { icon: ReactNode; value: number | null; suffix?: ReactNode }) {
  if (value == null) return null
  return (
    <div className="flex items-center gap-[1.1cqw]">
      <span className="text-[2.2cqw] font-normal leading-none text-navy">
        {value.toLocaleString('en-NZ')}
        {suffix}
      </span>
      <span className="h-[3cqw] w-[3.6cqw] text-navy [&>svg]:h-full [&>svg]:w-full">{icon}</span>
    </div>
  )
}

function Stage({ state, overlay }: { state: PublicDisplayState | null; overlay: DisplayOverlay }) {
  const idle = useIdleCursor()
  const pointer = useRecentPointer()
  const nav = useNavigate()
  const bidRef = useRef<HTMLDivElement>(null)
  const lost = overlay === 'CONNECTION_LOST'

  useEffect(() => {
    const el = bidRef.current
    if (!el) return
    el.classList.remove('bid-flash')
    void el.offsetWidth
    el.classList.add('bid-flash')
  }, [state?.currentBidCents])

  const p = state?.property
  const status = state ? STATUS_LINE[state.publicStatus] : null
  const stickers = !state?.overlayHidden
  const circle = state && stickers ? CIRCLE[state.publicStatus] : undefined
  const bid = state?.currentBidDisplay ?? ''
  const bidSize = bid.length > 11 ? 'text-[4.4cqw]' : bid.length > 10 ? 'text-[4.9cqw]' : 'text-[5.4cqw]'
  const label =
    state?.publicStatus === 'SOLD'
      ? 'Sold for:'
      : state?.publicStatus === 'PASSED_IN'
        ? 'Highest bid:'
        : state?.publicStatus === 'NOT_STARTED'
          ? 'Auction starts soon'
          : 'Current Bid:'

  return (
    <StageFrame idleCursor={idle}>
      {/* ── Header: address, features, logo ── */}
      <div className="absolute left-[2.6cqw] top-[2.2cqw] right-[30cqw]">
        <h1 className="truncate text-[3cqw] font-light leading-none text-navy">
          {p?.addressLine}
          {p?.suburb && (
            <>
              <span className="mx-[0.8cqw] text-navy/70">|</span>
              <span className="text-brand">{p.suburb}</span>
            </>
          )}
        </h1>
        <div className="mt-[1.6cqw] flex items-center gap-[3.2cqw]">
          <Feature icon={<BedIcon />} value={p?.bedrooms ?? null} />
          <Feature icon={<BathIcon />} value={p?.bathrooms ?? null} />
          <Feature icon={<GarageIcon />} value={p?.parking ?? null} />
          <Feature icon={<LandIcon />} value={p?.landAreaM2 ?? null} suffix={<span>m<sup className="text-[0.55em]">2</sup></span>} />
          <Feature icon={<FloorIcon />} value={p?.floorAreaM2 ?? null} suffix={<span>m<sup className="text-[0.55em]">2</sup></span>} />
        </div>
      </div>
      <div className="absolute right-[2.6cqw] top-[3.6cqw] flex h-[3.6cqw] items-center">
        <BrandLogo className="h-full" />
      </div>

      {/* ── Property photo ── */}
      <div className="absolute left-[0.5cqw] top-[11.4cqw] h-[40.6cqw] w-[66cqw] overflow-hidden">
        <PropertyImage src={p?.heroImage} />
        {stickers && p?.badge && (
          <div className="absolute left-[1cqw] top-[1cqw] flex h-[9cqw] w-[9cqw] items-center justify-center rounded-full bg-white p-[1cqw] text-center text-[1.45cqw] font-bold leading-[1.1] text-navy shadow-[0_0.3cqw_1.2cqw_rgba(0,29,74,0.18)]">
            {p.badge}
          </div>
        )}
        {circle && (
          <div
            data-testid="display-circle"
            className={`absolute left-1/2 top-1/2 flex h-[20cqw] w-[20cqw] -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-full text-center font-bold leading-[0.98] shadow-[0_0.5cqw_2cqw_rgba(0,29,74,0.25)] ${circle.cls} ${
              circle.lines.length === 1 ? 'text-[5cqw] tracking-[0.06em]' : 'text-[3.7cqw]'
            }`}
          >
            {circle.lines.map((l) => (
              <span key={l}>{l}</span>
            ))}
          </div>
        )}
      </div>

      {/* ── Current bid + salespeople ── */}
      <div className="absolute left-[66.5cqw] right-[0.5cqw] top-[11.4cqw] flex h-[40.6cqw] flex-col">
        <div className="flex flex-1 flex-col items-center justify-center">
          <div className="text-[3cqw] font-light leading-none text-navy">{label}</div>
          <div
            ref={bidRef}
            data-testid="display-bid"
            className={`mt-[1.8cqw] rounded-[0.5cqw] px-[1cqw] font-bold leading-none tracking-tight text-navy transition-opacity ${bidSize} ${lost ? 'opacity-25' : ''}`}
          >
            {bid ||
              (state?.publicStatus === 'LIVE' || state?.publicStatus === 'ON_THE_MARKET' ? (
                <span className="text-[2.4cqw] font-semibold text-ink-faint">Awaiting opening bid</span>
              ) : (
                <span className="text-[4cqw] text-ink-faint">—</span>
              ))}
          </div>
          {status && (
            <div
              data-testid="display-status"
              className={`mt-[2.2cqw] rounded-full px-[2.2cqw] py-[0.7cqw] text-[1.35cqw] font-bold uppercase tracking-[0.2em] ${status.cls}`}
            >
              {status.text}
            </div>
          )}
        </div>

        {state && state.salespeople?.length > 0 && <Salespeople people={state.salespeople} />}
      </div>

      {/* ── Footer bar ── */}
      <div className="absolute bottom-0 left-[0.5cqw] right-[0.5cqw] flex h-[3.7cqw] items-center justify-end bg-navy px-[2.2cqw]">
        {pointer && (
          <button
            data-testid="change-session"
            className="mr-auto rounded-[0.4cqw] border border-white/40 px-[1.2cqw] py-[0.3cqw] text-[1.2cqw] font-semibold text-white hover:bg-white/10"
            onClick={() => nav('/auction/pair?new=1')}
          >
            ⇄ Change session
          </button>
        )}
        <span className="text-[1.55cqw] font-light text-white">{FOOTER_TEXT}</span>
      </div>

      {/* ── Connection overlays — never present stale data as live ── */}
      {overlay === 'RECONNECTING' && (
        <div
          className="absolute inset-x-0 top-0 flex items-center justify-center bg-warn py-[0.5cqw] text-[1.2cqw] font-bold uppercase tracking-[0.2em] text-white"
          role="status"
        >
          Reconnecting…
        </div>
      )}
      {lost && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/75" role="alert" data-testid="connection-lost">
          <div className="rounded-[1cqw] border-[0.3cqw] border-bad bg-white px-[4cqw] py-[2.5cqw] text-center shadow-xl">
            <div className="text-[3.4cqw] font-bold uppercase tracking-[0.12em] text-bad">Connection lost</div>
            <div className="mt-[0.6cqw] text-[1.6cqw] text-ink-muted">Bid shown may be out of date · Reconnecting automatically</div>
          </div>
        </div>
      )}
      {!state && !lost && (
        <div className="absolute inset-0 flex items-center justify-center bg-white text-[2cqw] font-semibold text-ink-faint">Connecting…</div>
      )}
    </StageFrame>
  )
}

/** One salesperson: photo beside name. Two: side by side, photo above name. */
function Salespeople({ people }: { people: Salesperson[] }) {
  const two = people.length > 1
  return (
    <div className="mx-[2cqw] mb-[1.2cqw] border-t border-line pt-[1.4cqw]" data-testid="display-salespeople">
      <div className={`text-[1.1cqw] font-bold uppercase tracking-[0.24em] text-brand ${two ? 'text-center' : ''}`}>
        {two ? 'Salespeople' : 'Salesperson'}
      </div>
      {two ? (
        <div className="mt-[1cqw] grid grid-cols-2 gap-[1.6cqw]">
          {people.map((p) => (
            <div key={p.name} className="flex min-w-0 flex-col items-center text-center">
              <div className="h-[7.6cqw] w-[7.6cqw] shrink-0 overflow-hidden rounded-full border-[0.25cqw] border-brand bg-white">
                <PersonPhoto src={p.photo} />
              </div>
              <div className="mt-[0.7cqw] line-clamp-2 text-[1.75cqw] font-semibold leading-tight text-navy">{p.name}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-[0.9cqw] flex items-center gap-[1.8cqw]">
          <div className="h-[9cqw] w-[9cqw] shrink-0 overflow-hidden rounded-full border-[0.3cqw] border-brand bg-white">
            <PersonPhoto src={people[0].photo} />
          </div>
          <div className="min-w-0 text-[2.5cqw] font-semibold leading-tight text-navy">{people[0].name}</div>
        </div>
      )}
    </div>
  )
}

function NotPaired({ revoked }: { revoked: boolean }) {
  // Unattended room PCs: show a new pairing code by themselves after a short pause.
  const nav = useNavigate()
  useEffect(() => {
    const t = setTimeout(() => nav('/auction/pair', { replace: true }), 15_000)
    return () => clearTimeout(t)
  }, [nav])
  return (
    <StageFrame>
      <div className="flex h-full flex-col items-center justify-center gap-[2cqw]">
        <div className="h-[5cqw]">
          <BrandLogo className="h-full" />
        </div>
        <div className="text-[3cqw] font-bold text-navy">{revoked ? 'This display has been unpaired' : 'Display not paired'}</div>
        <div className="text-[1.6cqw] text-ink-muted">Ask staff to pair this screen with the auction session. A pairing code appears automatically.</div>
        <Link to="/auction/pair" className="btn-primary px-[3cqw] py-[1cqw] text-[1.6cqw]">
          Start pairing
        </Link>
      </div>
      <div className="absolute bottom-0 left-[0.5cqw] right-[0.5cqw] h-[3.7cqw] bg-navy" />
    </StageFrame>
  )
}
