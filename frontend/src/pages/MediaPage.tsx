import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { server } from '../app/server'
import { useUser } from '../app/user'
import welcomeFallback from '../assets/media/welcome.jpg'
import { ErrorNote } from '../components/ui'
import type { MediaFile } from '../engine/api'
import { useImage } from '../lib/imageStore'

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`

/** Read an image file for upload; very large files are scaled to 1920 px wide JPEG. */
async function imageForUpload(file: File): Promise<string> {
  const asDataUrl = () =>
    new Promise<string>((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(String(fr.result))
      fr.onerror = () => reject(fr.error)
      fr.readAsDataURL(file)
    })
  if (file.size <= 2_800_000 && /^image\/(jpeg|png|webp)$/.test(file.type)) return asDataUrl()
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const scale = Math.min(1, 1920 / img.naturalWidth)
    const c = document.createElement('canvas')
    c.width = Math.round(img.naturalWidth * scale)
    c.height = Math.round(img.naturalHeight * scale)
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
    return c.toDataURL('image/jpeg', 0.86)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Admin: the welcome image and music used on the room screen — the same for every session. */
export function MediaPage() {
  const { user } = useUser()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['media'], queryFn: () => server.media.get() })
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const m = q.data
  const welcomeImg = useImage(m?.welcomeImage ?? null) ?? welcomeFallback

  if (user.role !== 'admin') return <Navigate to="/auction/control" replace />

  const save = async (patch: Parameters<typeof server.media.set>[0]) => {
    const v = await server.media.set(patch)
    qc.setQueryData(['media'], v)
  }

  const act = async (key: string, fn: () => Promise<void>) => {
    setErr(null)
    setBusy(key)
    setProgress(0)
    try {
      await fn()
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(null)
    }
  }

  const uploadImage = (file: File) =>
    act('image', async () => {
      const ref = await server.uploadImage(await imageForUpload(file))
      await save({ welcomeImage: ref })
    })

  const uploadMusic = (which: 'welcomeMusic' | 'pauseMusic', file: File) =>
    act(which, async () => {
      const f = await server.media.uploadMusic(file, setProgress)
      await save({ [which]: f.id })
    })

  return (
    <div className="mx-auto max-w-5xl p-4 md:p-6">
      <h1 className="text-2xl font-bold text-navy">Room media</h1>
      <p className="mb-5 text-sm text-ink-muted">
        The welcome screen and music played on the room screen — the same for every session. Turn them on and off from the console
        (Welcome / Music buttons). Music also starts by itself when the auction is paused.
      </p>
      {err && (
        <div className="mb-4">
          <ErrorNote onDismiss={() => setErr(null)}>{err}</ErrorNote>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Welcome image" note="Shown full screen while “Welcome” is on. Best size 1920 × 1080 (16:9).">
          <div className="aspect-video overflow-hidden rounded-lg border border-line bg-navy">
            <img src={welcomeImg} alt="Welcome screen" className="h-full w-full object-cover" data-testid="media-welcome-preview" />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <FileButton accept="image/jpeg,image/png,image/webp" busy={busy === 'image'} onFile={uploadImage} label="Upload new image" testId="upload-image" />
            {m?.welcomeImage && (
              <button className="btn-ghost text-sm" disabled={!!busy} onClick={() => void act('image', () => save({ welcomeImage: null }))}>
                Use the built-in image
              </button>
            )}
            {!m?.welcomeImage && <span className="text-sm text-ink-muted">Using the built-in Golden Links welcome image</span>}
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          <Card title="Welcome music" note="Plays (looping) while the welcome screen is on.">
            <Track file={m?.welcomeMusic ?? null} empty="No music uploaded yet — the welcome screen will be silent." />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <FileButton accept="audio/*,.mp3,.m4a" busy={busy === 'welcomeMusic'} onFile={(f) => uploadMusic('welcomeMusic', f)} label="Upload music" testId="upload-welcome-music" />
              {busy === 'welcomeMusic' && <Progress value={progress} />}
            </div>
          </Card>

          <Card title="Pause music" note="Starts automatically when the auction is paused; the Music button turns it on or off.">
            {m?.pauseMusic ? (
              <Track file={m.pauseMusic} empty="" />
            ) : (
              <div className="rounded-md bg-subtle px-3 py-2 text-sm text-ink-muted">Same as the welcome music{m?.welcomeMusic ? '' : ' (none uploaded yet)'}</div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <FileButton accept="audio/*,.mp3,.m4a" busy={busy === 'pauseMusic'} onFile={(f) => uploadMusic('pauseMusic', f)} label="Upload different music" testId="upload-pause-music" />
              {m?.pauseMusic && (
                <button className="btn-ghost text-sm" disabled={!!busy} onClick={() => void act('pauseMusic', () => save({ pauseMusic: null }))}>
                  Use the welcome music
                </button>
              )}
              {busy === 'pauseMusic' && <Progress value={progress} />}
            </div>
          </Card>
        </div>
      </div>

      <Card className="mt-4" title="Room screen computer — allow sound once" note="">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-ink">
          <li>
            In Chrome on the room screen computer open this site, click the icon left of the address → <b>Site settings</b> → <b>Sound: Allow</b>.
          </li>
          <li>
            Kiosk shortcut: add <code className="rounded bg-subtle px-1">--autoplay-policy=no-user-gesture-required</code> to the Chrome shortcut.
          </li>
          <li>If sound is still blocked, the console shows a warning and the screen shows “Click to turn on sound” — one click on the screen fixes it.</li>
        </ol>
        <p className="mt-2 text-xs text-ink-muted">Playing commercial music in public needs a OneMusic NZ licence (or use royalty-free music).</p>
      </Card>
    </div>
  )
}

function Card({ title, note, children, className = '' }: { title: string; note: string; children: ReactNode; className?: string }) {
  return (
    <section className={`panel p-4 ${className}`}>
      <h2 className="text-lg font-bold text-navy">{title}</h2>
      {note && <p className="mb-3 text-sm text-ink-muted">{note}</p>}
      {children}
    </section>
  )
}

function Track({ file, empty }: { file: MediaFile | null; empty: string }) {
  const src = useImage(file?.url ?? null)
  if (!file) return <div className="rounded-md bg-subtle px-3 py-2 text-sm text-ink-muted">{empty}</div>
  return (
    <div className="rounded-md border border-line px-3 py-2">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="truncate font-semibold text-navy" data-testid="media-track-name">
          ♪ {file.name}
        </span>
        <span className="shrink-0 text-ink-muted">{mb(file.size)}</span>
      </div>
      {src && <audio controls preload="none" src={src} className="mt-2 h-9 w-full" />}
    </div>
  )
}

function FileButton({ accept, onFile, label, busy, testId }: { accept: string; onFile: (f: File) => void; label: string; busy: boolean; testId: string }) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="hidden"
        data-testid={testId}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onFile(f)
          e.target.value = ''
        }}
      />
      <button className="btn-primary text-sm" disabled={busy} onClick={() => ref.current?.click()}>
        {busy ? 'Uploading…' : label}
      </button>
    </>
  )
}

function Progress({ value }: { value: number }) {
  return (
    <div className="h-2 w-40 overflow-hidden rounded-full bg-subtle" aria-label="Upload progress">
      <div className="h-full bg-brand transition-[width]" style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  )
}
