import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { loadCredential, saveCredential } from '../app/displaySync'
import { server } from '../app/server'
import { BrandLogo } from '../components/brand'
import type { PinSession } from '../engine/types'
import { StageFrame } from './DisplayPage'

const RESUME_SECS = 8
const PIN_LEN = 4

/**
 * Device side of pairing — runs on the room display computer. No staff login.
 * Already paired → shows which property this screen is on, returns to it after a few seconds
 * (kiosk reboot) or, on request, shows a new code to switch this screen to another session.
 */
export function PairPage() {
  const nav = useNavigate()
  const wantNew = new URLSearchParams(window.location.search).has('new')
  const [mode, setMode] = useState<'checking' | 'paired' | 'pairing'>(() => (loadCredential() && !wantNew ? 'checking' : 'pairing'))
  const [current, setCurrent] = useState<{ sessionId: string; address: string } | null>(null)
  const [req, setReq] = useState<{ pairingId: string; code: string; expiresAt: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [resumeAt, setResumeAt] = useState(0)
  // PIN pairing on the screen itself
  const [pin, setPin] = useState('')
  const [pinErr, setPinErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [choices, setChoices] = useState<PinSession[] | null>(null)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [])

  // Already paired?
  useEffect(() => {
    if (mode !== 'checking') return
    const cred = loadCredential()
    if (!cred) return setMode('pairing')
    let cancelled = false
    server.display
      .getPublicState(cred.token)
      .then((st) => {
        if (cancelled) return
        if (st.sessionStatus === 'ENDED') {
          // finished auction → this screen needs a new session
          setMode('pairing')
          return
        }
        setCurrent({ sessionId: st.sessionId, address: [st.property.addressLine, st.property.suburb].filter(Boolean).join(', ') })
        setResumeAt(Date.now() + RESUME_SECS * 1000)
        setMode('paired')
      })
      .catch(() => !cancelled && setMode('pairing'))
    return () => {
      cancelled = true
    }
  }, [mode])

  // Paired and nobody touched it → back to the display (kiosk reboot)
  useEffect(() => {
    if (mode === 'paired' && current && resumeAt && now >= resumeAt) nav(`/auction/display/${current.sessionId}`, { replace: true })
  }, [mode, current, resumeAt, now, nav])

  // Request a code (and a fresh one whenever it expires)
  const needCode = mode === 'pairing' && (req === null || Date.parse(req.expiresAt) <= now)
  useEffect(() => {
    if (!needCode) return
    let cancelled = false
    server.display
      .requestPairing()
      .then((r) => !cancelled && (setReq(r), setErr(null)))
      .catch((e) => !cancelled && setErr(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
  }, [needCode])

  // Poll for approval
  useEffect(() => {
    if (mode !== 'pairing' || !req) return
    const t = setInterval(async () => {
      try {
        const previous = loadCredential()
        const r = await server.display.pollPairing(req.pairingId, previous?.token ?? null)
        if (r.status === 'APPROVED' && r.token && r.sessionId && r.deviceId) {
          saveCredential({ token: r.token, sessionId: r.sessionId, deviceId: r.deviceId })
          nav(`/auction/display/${r.sessionId}`, { replace: true })
        } else if (r.status === 'EXPIRED') setReq(null)
        setErr(null)
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      }
    }, 1500)
    return () => clearInterval(t)
  }, [mode, req, nav])

  const checkPin = useCallback(
    async (value: string) => {
      setBusy(true)
      setPinErr(null)
      try {
        setChoices(await server.display.pinSessions(value))
      } catch (e) {
        setPin('')
        setPinErr(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  const typeDigit = useCallback(
    (k: string) => {
      if (busy || choices) return
      setPinErr(null)
      if (k === '⌫') return setPin(pin.slice(0, -1))
      if (pin.length >= PIN_LEN) return
      const next = pin + k
      setPin(next)
      if (next.length === PIN_LEN) void checkPin(next)
    },
    [busy, choices, checkPin, pin],
  )

  // The screen PC's keyboard works too
  useEffect(() => {
    if (mode !== 'pairing' || choices) return
    const onKey = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) typeDigit(e.key)
      else if (e.key === 'Backspace') typeDigit('⌫')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, choices, typeDigit])

  const pairWith = async (sessionId: string) => {
    setBusy(true)
    setPinErr(null)
    try {
      const g = await server.display.pinPair(pin, sessionId, loadCredential()?.token ?? null)
      saveCredential({ token: g.token, sessionId: g.sessionId, deviceId: g.deviceId })
      nav(`/auction/display/${g.sessionId}`, { replace: true })
    } catch (e) {
      setPinErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const backToPin = () => {
    setChoices(null)
    setPin('')
    setPinErr(null)
  }

  const secs = req ? Math.max(0, Math.round((Date.parse(req.expiresAt) - now) / 1000)) : 0
  const resumeIn = Math.min(RESUME_SECS, Math.max(0, Math.ceil((resumeAt - now) / 1000)))

  return (
    <StageFrame>
      <div className="absolute left-[2.6cqw] top-[3.6cqw] h-[3.6cqw]">
        <BrandLogo className="h-full" />
      </div>

      {mode === 'paired' && current ? (
        <div className="flex h-full flex-col items-center justify-center gap-[2.2cqw]" data-testid="already-paired">
          <div className="text-[1.6cqw] font-bold uppercase tracking-[0.3em] text-brand">This screen is showing</div>
          <div className="max-w-[80cqw] text-center text-[4.2cqw] font-bold leading-tight text-navy">{current.address || 'an auction'}</div>
          <div className="mt-[1cqw] flex gap-[1.6cqw]">
            <button
              className="rounded-[0.8cqw] bg-navy px-[3cqw] py-[1.3cqw] text-[1.8cqw] font-bold text-white"
              onClick={() => nav(`/auction/display/${current.sessionId}`, { replace: true })}
            >
              Show it now
            </button>
            <button
              className="rounded-[0.8cqw] border-[0.25cqw] border-brand px-[3cqw] py-[1.3cqw] text-[1.8cqw] font-bold text-navy"
              data-testid="pair-different"
              onClick={() => {
                setResumeAt(0)
                setMode('pairing')
              }}
            >
              Show a different session
            </button>
          </div>
          <div className="text-[1.4cqw] text-ink-faint">Returning to the display in {resumeIn}s…</div>
        </div>
      ) : mode === 'checking' ? (
        <div className="flex h-full items-center justify-center text-[2cqw] text-ink-muted">Checking this screen…</div>
      ) : choices ? (
        <div className="flex h-full flex-col items-center justify-center gap-[1.8cqw] px-[6cqw]" data-testid="pin-sessions">
          <div className="text-[1.6cqw] font-bold uppercase tracking-[0.3em] text-brand">Which auction should this screen show?</div>
          {choices.length === 0 ? (
            <div className="text-[1.8cqw] text-ink-muted">No open auction sessions. Create one on the Sessions page first.</div>
          ) : (
            <div className="grid max-h-[30cqw] w-full max-w-[70cqw] gap-[1cqw] overflow-y-auto p-[0.4cqw]">
              {choices.map((c) => (
                <button
                  key={c.id}
                  disabled={busy}
                  onClick={() => void pairWith(c.id)}
                  className="flex items-center justify-between gap-[2cqw] rounded-[1.2cqw] border border-white bg-white/80 px-[2.4cqw] py-[1.4cqw] text-left shadow-[0_0.6cqw_1.6cqw_-0.8cqw_rgba(0,29,74,0.35)] transition hover:bg-white disabled:opacity-50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[2.2cqw] font-bold text-navy">
                      {[c.addressLine, c.suburb].filter(Boolean).join(', ') || 'Auction'}
                    </span>
                    {c.scheduledAt && (
                      <span className="block text-[1.3cqw] text-ink-muted">
                        {new Date(c.scheduledAt).toLocaleString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 rounded-full bg-brand/10 px-[1.2cqw] py-[0.4cqw] text-[1.2cqw] font-bold uppercase tracking-wider text-brand">
                    {c.status.replace('_', ' ').toLowerCase()}
                  </span>
                </button>
              ))}
            </div>
          )}
          {pinErr && <div className="rounded-[0.6cqw] bg-bad/10 px-[2cqw] py-[0.6cqw] text-[1.4cqw] text-bad">{pinErr}</div>}
          <button className="text-[1.4cqw] font-semibold text-ink-muted underline" onClick={backToPin}>
            Back
          </button>
        </div>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-[1.6cqw]">
          <div className="text-[1.6cqw] font-bold uppercase tracking-[0.3em] text-brand">Pair this room screen</div>
          <div className="text-[1.6cqw] text-ink-muted">Enter the screen PIN</div>
          <div className="flex gap-[1cqw]" data-testid="pin-boxes" aria-label={`PIN, ${pin.length} of ${PIN_LEN} digits entered`}>
            {Array.from({ length: PIN_LEN }, (_, i) => (
              <span
                key={i}
                className={`flex h-[7cqw] w-[5.6cqw] items-center justify-center rounded-[1cqw] border text-[4cqw] font-bold transition ${
                  i < pin.length ? 'border-brand bg-brand text-white shadow-[0_0.6cqw_1.4cqw_-0.6cqw_rgba(0,161,233,0.8)]' : 'border-white bg-white/80 text-navy shadow-[inset_0_0.15cqw_0.4cqw_rgba(0,29,74,0.12)]'
                }`}
              >
                {i < pin.length ? '•' : ''}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-[0.8cqw]" data-testid="pin-pad">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k, i) =>
              k === '' ? (
                <span key={i} />
              ) : (
                <button
                  key={i}
                  aria-label={k === '⌫' ? 'Delete digit' : `PIN digit ${k}`}
                  disabled={busy}
                  onClick={() => typeDigit(k)}
                  className="h-[5cqw] w-[7cqw] rounded-[1cqw] border border-white bg-white/85 text-[2.4cqw] font-semibold text-navy shadow-[0_0.4cqw_1cqw_-0.5cqw_rgba(0,29,74,0.35)] transition active:translate-y-[0.1cqw] disabled:opacity-50"
                >
                  {k}
                </button>
              ),
            )}
          </div>
          <div className="h-[2.4cqw]">
            {busy ? (
              <span className="text-[1.4cqw] text-ink-muted">Checking…</span>
            ) : (
              pinErr && <span className="rounded-[0.6cqw] bg-bad/10 px-[2cqw] py-[0.5cqw] text-[1.4cqw] text-bad" data-testid="pin-error">{pinErr}</span>
            )}
          </div>
          <div className="flex items-center gap-[1cqw] text-[1.25cqw] text-ink-faint">
            <span>Or on the staff console → Room display, enter code</span>
            <span className="font-bold tracking-[0.25em] text-navy" aria-label="Pairing code" data-testid="pair-code">
              {req?.code ?? '······'}
            </span>
            <span>({Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')})</span>
          </div>
          {err && <div className="rounded bg-bad/10 px-[2cqw] py-[0.6cqw] text-[1.4cqw] text-bad">{err}</div>}
        </div>
      )}
      <div className="absolute bottom-0 left-[0.5cqw] right-[0.5cqw] h-[3.7cqw] bg-navy" />
    </StageFrame>
  )
}
