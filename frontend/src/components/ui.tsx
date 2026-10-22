import { useEffect, useRef, type ReactNode } from 'react'

export function Modal({
  title,
  children,
  onClose,
  tone = 'default',
}: {
  title: string
  children: ReactNode
  onClose: () => void
  tone?: 'default' | 'danger' | 'ok'
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const first = ref.current?.querySelector<HTMLElement>('[data-autofocus], input, textarea, button')
    first?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
      if (e.key === 'Tab' && ref.current) {
        const els = Array.from(
          ref.current.querySelectorAll<HTMLElement>('button, input, textarea, select, [tabindex]:not([tabindex="-1"])'),
        ).filter((el) => !el.hasAttribute('disabled'))
        if (!els.length) return
        const [f, l] = [els[0], els[els.length - 1]]
        if (e.shiftKey && document.activeElement === f) (e.preventDefault(), l.focus())
        else if (!e.shiftKey && document.activeElement === l) (e.preventDefault(), f.focus())
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      prev?.focus?.()
    }
  }, [onClose])
  const bar = tone === 'danger' ? 'bg-bad' : tone === 'ok' ? 'bg-ok' : 'bg-brand'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy/30 p-4 backdrop-blur-sm" role="presentation">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-lg overflow-hidden rounded-3xl border border-white/80 bg-white/90 shadow-[0_30px_80px_-20px_rgba(0,29,74,0.45)] backdrop-blur-xl"
      >
        <div className={`h-1 ${bar}`} />
        <div className="p-6">
          <h2 className="mb-4 text-xl font-bold text-navy">{title}</h2>
          {children}
        </div>
      </div>
    </div>
  )
}

type ChipTone = 'ok' | 'warn' | 'bad' | 'neutral' | 'brand'

export function Chip({ label, value, tone }: { label: string; value: ReactNode; tone: ChipTone }) {
  const dot = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', neutral: 'bg-ink-faint', brand: 'bg-brand' }[tone]
  const ring = {
    ok: 'border-white/90 bg-white/70',
    warn: 'border-warn/40 bg-warn/10',
    bad: 'border-bad/50 bg-bad/10',
    neutral: 'border-white/90 bg-white/70',
    brand: 'border-brand/30 bg-brand/5',
  }[tone]
  return (
    <div className={`flex items-center gap-2.5 rounded-full border px-3.5 py-2 shadow-[0_4px_14px_-8px_rgba(15,35,70,0.25)] backdrop-blur-md ${ring}`} role="status">
      <span className={`h-3 w-3 shrink-0 rounded-full ${dot}`} aria-hidden />
      <span className="text-xs font-bold uppercase tracking-[0.1em] text-ink-muted">{label}</span>
      <span className="text-base font-bold uppercase tracking-wide text-navy">{value}</span>
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-md border border-line bg-white px-1.5 py-0.5 font-sans text-[10px] font-semibold text-ink-muted">
      {children}
    </kbd>
  )
}

export function ErrorNote({ children, onDismiss }: { children: ReactNode; onDismiss?: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-red-700" role="alert">
      <span>{children}</span>
      {onDismiss && (
        <button className="text-xs font-semibold text-red-700 underline" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  )
}
