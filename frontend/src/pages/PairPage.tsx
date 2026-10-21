import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { loadCredential, saveCredential } from '../app/displaySync'
import { server } from '../app/server'
import { BrandLogo } from '../components/brand'
import { StageFrame } from './DisplayPage'

const RESUME_SECS = 8

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
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-[2.4cqw]">
          <div className="text-[1.6cqw] font-bold uppercase tracking-[0.3em] text-brand">Pair this room display</div>
          <div className="flex gap-[1cqw]" aria-label="Pairing code" data-testid="pair-code">
            {(req?.code ?? '······').split('').map((c, i) => (
              <span key={i} className="flex h-[11cqw] w-[8.5cqw] items-center justify-center rounded-[0.8cqw] bg-navy text-[7cqw] font-bold text-white">
                {c}
              </span>
            ))}
          </div>
          <div className="max-w-[64cqw] text-center text-[1.7cqw] leading-snug text-ink-muted">
            On the staff console, open the session you want on this screen, go to <b className="text-navy">Room display</b> and enter this code.
          </div>
          <div className="text-[1.3cqw] text-ink-faint">
            Code expires in {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')} · a new code is issued automatically
          </div>
          {err && <div className="rounded bg-bad/10 px-[2cqw] py-[0.6cqw] text-[1.4cqw] text-bad">{err}</div>}
        </div>
      )}
      <div className="absolute bottom-0 left-[0.5cqw] right-[0.5cqw] h-[3.7cqw] bg-navy" />
    </StageFrame>
  )
}
