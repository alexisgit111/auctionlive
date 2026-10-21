/**
 * Room screen media: the welcome image overlay and the music player.
 *  - Which track: welcome on → welcome music; else music on → pause music (falls back to welcome music).
 *  - Both tracks are preloaded and loop; switching fades out / in over ~1.2 s.
 *  - Browsers may block sound until someone clicks the page: we detect that, show a small prompt,
 *    and report it to the console through the heartbeat (see app/roomAudio.ts).
 */
import { useEffect, useRef, useState } from 'react'
import { setAudioStatus } from '../../app/roomAudio'
import welcomeFallback from '../../assets/media/welcome.jpg'
import type { PublicDisplayState } from '../../engine/types'
import { useImage } from '../../lib/imageStore'

const FADE_MS = 1200
const STEP_MS = 50

export function WelcomeOverlay({ state }: { state: PublicDisplayState | null }) {
  const custom = useImage(state?.media?.welcomeImage ?? null)
  const src = custom ?? welcomeFallback
  const on = !!state?.welcomeOn
  return (
    <div
      data-testid="welcome-overlay"
      data-on={on ? 'true' : 'false'}
      aria-hidden={!on}
      className={`absolute inset-0 z-10 bg-navy transition-opacity duration-700 ${on ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
    >
      <img src={src} alt="" className="h-full w-full object-cover" draggable={false} />
    </div>
  )
}

type Role = 'welcome' | 'pause'

export function RoomAudio({ state }: { state: PublicDisplayState | null }) {
  const welcomeSrc = useImage(state?.media?.welcomeMusic ?? null)
  const pauseSrc = useImage(state?.media?.pauseMusic ?? state?.media?.welcomeMusic ?? null)
  const els = useRef<Record<Role, HTMLAudioElement | null>>({ welcome: null, pause: null })
  const fades = useRef<Record<Role, ReturnType<typeof setInterval> | null>>({ welcome: null, pause: null })
  const [blocked, setBlocked] = useState(false)

  const active: Role | null = state?.welcomeOn ? 'welcome' : state?.musicOn ? 'pause' : null
  const activeSrc = active === 'welcome' ? welcomeSrc : active === 'pause' ? pauseSrc : null
  const target = Math.max(0, Math.min(1, (state?.volume ?? 80) / 100))

  const fadeTo = (role: Role, to: number, then?: () => void) => {
    const el = els.current[role]
    if (!el) return
    if (fades.current[role]) clearInterval(fades.current[role]!)
    const from = el.volume
    const steps = Math.max(1, Math.round(FADE_MS / STEP_MS))
    let i = 0
    fades.current[role] = setInterval(() => {
      i++
      el.volume = Math.max(0, Math.min(1, from + ((to - from) * i) / steps))
      if (i >= steps) {
        clearInterval(fades.current[role]!)
        fades.current[role] = null
        then?.()
      }
    }, STEP_MS)
  }

  const start = async (role: Role) => {
    const el = els.current[role]
    if (!el) return
    if (el.paused) {
      if (role === 'welcome') el.currentTime = 0 // the welcome song starts from the top; pause music resumes
      el.volume = 0
      setAudioStatus('loading')
      try {
        await el.play()
        setBlocked(false)
      } catch (e) {
        if ((e as DOMException)?.name === 'NotAllowedError') {
          setBlocked(true)
          setAudioStatus('blocked')
        } else setAudioStatus('error')
        return
      }
    }
    fadeTo(role, target)
  }

  // Switch tracks / volume
  useEffect(() => {
    ;(['welcome', 'pause'] as Role[]).forEach((role) => {
      const el = els.current[role]
      if (!el) return
      if (role === active && activeSrc) void start(role)
      else if (!el.paused) fadeTo(role, 0, () => el.pause())
    })
    if (!active || !activeSrc) setAudioStatus('off')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, activeSrc, target])

  // Blocked by the browser → the first click / key on this page turns sound on.
  useEffect(() => {
    if (!blocked) return
    const unlock = () => {
      if (active) void start(active)
    }
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocked, active])

  useEffect(
    () => () => {
      Object.values(fades.current).forEach((t) => t && clearInterval(t))
      setAudioStatus('off')
    },
    [],
  )

  const bind = (role: Role) => (el: HTMLAudioElement | null) => {
    els.current[role] = el
  }
  const onPlaying = (role: Role) => () => role === active && setAudioStatus('playing')
  const onError = (role: Role) => () => role === active && setAudioStatus('error')

  return (
    <>
      {welcomeSrc && (
        <audio ref={bind('welcome')} src={welcomeSrc} preload="auto" loop onPlaying={onPlaying('welcome')} onError={onError('welcome')} data-testid="audio-welcome" />
      )}
      {pauseSrc && (
        <audio ref={bind('pause')} src={pauseSrc} preload="auto" loop onPlaying={onPlaying('pause')} onError={onError('pause')} data-testid="audio-pause" />
      )}
      {blocked && active && (
        <button
          data-testid="sound-blocked"
          className="absolute bottom-[5cqw] left-[2cqw] z-20 rounded-full bg-warn px-[1.6cqw] py-[0.7cqw] text-[1.3cqw] font-bold text-white shadow-lg"
          onClick={() => void start(active)}
        >
          🔊 Click to turn on sound
        </button>
      )}
    </>
  )
}
