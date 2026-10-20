import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { loadCredential, saveCredential } from '../app/displaySync'
import { server } from '../app/server'
import { BrandLogo } from '../components/brand'
import { StageFrame } from './DisplayPage'

/** Device side of pairing — runs on the room display computer. No staff login. */
export function PairPage() {
  const nav = useNavigate()
  const [req, setReq] = useState<{ pairingId: string; code: string; expiresAt: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

  // Kiosk-friendly: a screen that is already paired goes straight back to its display
  // (e.g. after a reboot with Chrome opening /auction/pair). Revoked → the display page clears it.
  useEffect(() => {
    const cred = loadCredential()
    if (!cred || new URLSearchParams(window.location.search).has('new')) return
    let cancelled = false
    server.display
      .getPublicState(cred.token)
      .then((st) => {
        if (cancelled) return
        // A finished auction needs a new pairing for the next session.
        if (st.sessionStatus === 'ENDED') saveCredential(null)
        else nav(`/auction/display/${cred.sessionId}`, { replace: true })
      })
      .catch(() => {
        /* revoked or offline — stay here and pair */
      })
    return () => {
      cancelled = true
    }
  }, [nav])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [])

  // Request a code (and a fresh one whenever it expires)
  useEffect(() => {
    if (req && Date.parse(req.expiresAt) > now) return
    let cancelled = false
    server.display
      .requestPairing()
      .then((r) => !cancelled && (setReq(r), setErr(null)))
      .catch((e) => !cancelled && setErr(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req === null || Date.parse(req?.expiresAt ?? '0') <= now])

  // Poll for approval
  useEffect(() => {
    if (!req) return
    const t = setInterval(async () => {
      try {
        const r = await server.display.pollPairing(req.pairingId)
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
  }, [req, nav])

  const secs = req ? Math.max(0, Math.round((Date.parse(req.expiresAt) - now) / 1000)) : 0
  return (
    <StageFrame>
      <div className="absolute left-[2.6cqw] top-[3.6cqw] h-[3.6cqw]">
        <BrandLogo className="h-full" />
      </div>
      <div className="flex h-full flex-col items-center justify-center gap-[2.4cqw]">
        <div className="text-[1.6cqw] font-bold uppercase tracking-[0.3em] text-brand">Pair this room display</div>
        <div className="flex gap-[1cqw]" aria-label="Pairing code" data-testid="pair-code">
          {(req?.code ?? '······').split('').map((c, i) => (
            <span key={i} className="flex h-[11cqw] w-[8.5cqw] items-center justify-center rounded-[0.8cqw] bg-navy text-[7cqw] font-bold text-white">
              {c}
            </span>
          ))}
        </div>
        <div className="max-w-[60cqw] text-center text-[1.7cqw] leading-snug text-ink-muted">
          On the staff console, go to <b className="text-navy">Room display</b> and enter this code to approve.
        </div>
        <div className="text-[1.3cqw] text-ink-faint">
          Code expires in {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')} · a new code is issued automatically
        </div>
        {err && <div className="rounded bg-bad/10 px-[2cqw] py-[0.6cqw] text-[1.4cqw] text-bad">{err}</div>}
      </div>
      <div className="absolute bottom-0 left-[0.5cqw] right-[0.5cqw] h-[3.7cqw] bg-navy" />
    </StageFrame>
  )
}
