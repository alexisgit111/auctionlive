import { useEffect, useMemo, useRef, useState } from 'react'
import type { CloudStatus } from '../../app/hooks'
import { formatCents, formatCompact, parseBidInput, type Cents } from '../../lib/money'
import { Kbd } from '../ui'

export const QUICK_INCREMENTS_K = [1, 5, 10, 25, 50, 100]

interface Props {
  currentCents: Cents | null
  defaultIncrementCents: Cents
  canBid: boolean
  disabledReason: string | null
  pending: boolean
  cloud: CloudStatus
  /** Called with confirmed amount. Returns true on success. */
  onSubmit: (cents: Cents) => Promise<boolean>
  onUndoShortcut: () => void
  onPauseShortcut: () => void
}

const ALLOWED = /^[0-9.,kKmM ]*$/

export function BidEntry(p: Props) {
  const [input, setInput] = useState('')
  const [stage, setStage] = useState<'input' | 'confirm'>('input')
  const [increment, setIncrement] = useState<Cents>(p.defaultIncrementCents)
  const [flash, setFlash] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => setIncrement(p.defaultIncrementCents), [p.defaultIncrementCents])

  const parsed = useMemo(() => parseBidInput(input), [input])
  const issue = useMemo(() => {
    if (!input.trim()) return null
    if (!parsed.ok) return parsed.message
    if (p.currentCents !== null && parsed.cents <= p.currentCents) return `Must be higher than current bid ${formatCents(p.currentCents)}`
    return null
  }, [input, parsed, p.currentCents])
  const amount = parsed.ok && !issue ? parsed.cents : null
  const nextPreview = p.currentCents !== null ? p.currentCents + increment : null
  const offline = p.cloud === 'OFFLINE'
  const blocked = !p.canBid || p.pending

  const focus = () => inputRef.current?.focus()

  const reset = () => {
    setInput('')
    setStage('input')
    focus()
  }

  const submit = async () => {
    if (amount === null || blocked) return
    const ok = await p.onSubmit(amount)
    if (ok) {
      setFlash((x) => x + 1)
      reset()
    } else {
      setStage('input')
      focus()
    }
  }

  const loadIncrement = (inc: Cents) => {
    if (p.currentCents === null || blocked) return
    setInput(formatCompact(p.currentCents + inc))
    setStage('confirm')
    focus()
  }

  const onEnter = () => {
    if (blocked) return
    if (stage === 'input') {
      if (amount !== null) setStage('confirm')
    } else void submit()
  }

  const onEscape = () => {
    if (stage === 'confirm') setStage('input')
    else setInput('')
  }

  // Global shortcuts (ignored while a dialog is open or another field is focused)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return
      const t = e.target as HTMLElement
      const inOtherField = (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') && t !== inputRef.current
      if (inOtherField) return
      const fIdx = /^F([1-6])$/.exec(e.key)
      if (fIdx) {
        e.preventDefault()
        loadIncrement(BigInt(QUICK_INCREMENTS_K[+fIdx[1] - 1]) * 1000n * 100n)
        return
      }
      if (e.code === 'NumpadAdd' || (e.key === '+' && t !== inputRef.current)) {
        e.preventDefault()
        loadIncrement(increment)
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        p.onUndoShortcut()
        return
      }
      if ((e.key === 'p' || e.key === 'P') && input === '') {
        e.preventDefault()
        p.onPauseShortcut()
        return
      }
      // Typing anywhere goes to the amount field
      if (t !== inputRef.current && /^[0-9.kKmM]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        setInput((v) => v + e.key.toUpperCase())
        setStage('input')
        focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const press = (k: string) => {
    if (k === '⌫') setInput((v) => v.slice(0, -1))
    else if (k === 'C') setInput('')
    else setInput((v) => v + k)
    setStage('input')
    focus()
  }

  return (
    <div className="grid grid-cols-[1fr_auto] gap-4">
      {/* Left: entry + preview + increments */}
      <div className="flex min-w-0 flex-col gap-3">
        <div className="panel p-4">
          <div className="flex items-baseline justify-between">
            <label htmlFor="bid-input" className="panel-title">
              Enter accepted bid
            </label>
            <span className="text-[11px] text-ink-faint">
              e.g. <b className="text-ink-muted">1275K</b> · <b className="text-ink-muted">1.275M</b> · <b className="text-ink-muted">1275000</b>
            </span>
          </div>
          <input
            ref={inputRef}
            id="bid-input"
            autoFocus
            autoComplete="off"
            inputMode="decimal"
            spellCheck={false}
            value={input}
            disabled={!p.canBid}
            aria-invalid={!!issue}
            aria-describedby="bid-preview"
            onChange={(e) => {
              if (!ALLOWED.test(e.target.value)) return
              setInput(e.target.value.toUpperCase())
              setStage('input')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.preventDefault(), onEnter())
              if (e.key === 'Escape') (e.preventDefault(), onEscape())
              if (e.key === '+') e.preventDefault()
            }}
            placeholder={p.canBid ? 'Type amount…' : (p.disabledReason ?? 'Bidding unavailable')}
            className={`mt-2 w-full rounded-md border-2 bg-surface px-4 py-3 text-right text-5xl font-bold tracking-tight text-navy placeholder:text-left placeholder:text-xl placeholder:font-semibold placeholder:text-ink-faint focus:outline-none ${
              issue ? 'border-bad' : stage === 'confirm' ? 'border-brand' : 'border-line focus:border-brand'
            } disabled:opacity-50`}
          />

          {/* Preview / confirm */}
          <div
            id="bid-preview"
            aria-live="polite"
            className={`mt-3 flex min-h-[84px] items-center justify-between gap-4 rounded-md px-4 py-3 ${
              stage === 'confirm' ? 'bg-brand text-white' : issue ? 'bg-bad/10' : 'bg-subtle'
            }`}
          >
            {issue ? (
              <span className="text-base font-semibold text-bad">{issue}</span>
            ) : amount !== null ? (
              <>
                <div>
                  <div className={`text-[11px] font-bold uppercase tracking-[0.14em] ${stage === 'confirm' ? 'text-white/80' : 'text-ink-muted'}`}>
                    {stage === 'confirm' ? (offline ? 'Record provisional bid?' : 'Confirm bid') : 'Preview'}
                    {p.currentCents !== null && (
                      <span className="ml-2 normal-case tracking-normal">
                        (+{formatCents(amount - p.currentCents)})
                      </span>
                    )}
                  </div>
                  <div className="text-4xl font-bold tracking-tight">{formatCents(amount)}</div>
                </div>
                {stage === 'confirm' ? (
                  <div className="flex gap-2">
                    <button className="btn border border-white/40 text-white hover:bg-white/10" onClick={() => setStage('input')}>
                      Cancel <Kbd>Esc</Kbd>
                    </button>
                    <button
                      className="btn bg-white px-6 py-3 text-lg text-navy hover:bg-brand-100"
                      onClick={() => void submit()}
                      disabled={blocked}
                      data-testid="confirm-bid"
                    >
                      {p.pending ? 'Sending…' : offline ? 'Record offline' : 'Confirm'} <Kbd>Enter</Kbd>
                    </button>
                  </div>
                ) : (
                  <button className="btn-primary px-6 py-3 text-lg" onClick={() => setStage('confirm')} disabled={blocked}>
                    Enter bid <Kbd>Enter</Kbd>
                  </button>
                )}
              </>
            ) : (
              <span className="text-sm text-ink-faint">
                {p.canBid ? (
                  <>
                    Type an amount, then <Kbd>Enter</Kbd> to preview and <Kbd>Enter</Kbd> again to confirm.
                  </>
                ) : (
                  p.disabledReason
                )}
              </span>
            )}
          </div>
        </div>

        <div className="panel p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="panel-title">Quick bid (current + increment)</span>
            <span className="text-[11px] text-ink-faint">
              <Kbd>F1</Kbd>–<Kbd>F6</Kbd> · <Kbd>Num +</Kbd> = default
            </span>
          </div>
          <div className="grid grid-cols-6 gap-2">
            {QUICK_INCREMENTS_K.map((k, i) => {
              const inc = BigInt(k) * 1000n * 100n
              return (
                <button
                  key={k}
                  className="btn-navy flex-col gap-0 py-3"
                  disabled={blocked || p.currentCents === null}
                  onClick={() => loadIncrement(inc)}
                >
                  <span className="text-lg">+{k}K</span>
                  <span className="text-[10px] font-semibold text-white/50">F{i + 1}</span>
                </button>
              )
            })}
          </div>
          <div className="mt-3 flex items-center gap-3 border-t border-line pt-3">
            <span className="panel-title">Default increment</span>
            <div className="flex gap-1" role="radiogroup" aria-label="Default increment">
              {QUICK_INCREMENTS_K.map((k) => {
                const inc = BigInt(k) * 1000n * 100n
                const on = inc === increment
                return (
                  <button
                    key={k}
                    role="radio"
                    aria-checked={on}
                    onClick={() => setIncrement(inc)}
                    className={`rounded px-2.5 py-1 text-sm font-semibold ${on ? 'bg-brand text-white' : 'bg-subtle text-ink-muted hover:bg-subtle-2'}`}
                  >
                    {k}K
                  </button>
                )
              })}
            </div>
            <div className="ml-auto text-right">
              <div className="panel-title">Next bid preview</div>
              <div key={flash} className="text-xl font-bold text-brand">
                {nextPreview !== null ? formatCents(nextPreview) : '—'}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Right: calculator keypad */}
      <div className="panel w-[260px] p-3" aria-label="Keypad">
        <div className="grid grid-cols-3 gap-2">
          {['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', '⌫', 'K', 'M', 'C'].map((k) => (
            <button
              key={k}
              tabIndex={-1}
              disabled={!p.canBid}
              onClick={() => press(k)}
              aria-label={k === '⌫' ? 'Backspace' : k === 'C' ? 'Clear' : k}
              className={`h-[62px] rounded-md text-2xl font-bold transition-colors disabled:opacity-30 ${
                k === 'K' || k === 'M'
                  ? 'bg-brand/20 text-brand hover:bg-brand/30'
                  : k === 'C' || k === '⌫'
                    ? 'bg-subtle text-ink-muted hover:bg-subtle-2'
                    : 'bg-surface-3 text-navy hover:bg-brand-100'
              }`}
            >
              {k}
            </button>
          ))}
        </div>
        <button
          className="btn-primary mt-2 h-[62px] w-full text-xl"
          disabled={blocked || amount === null}
          onClick={onEnter}
        >
          {stage === 'confirm' ? 'Confirm' : 'Enter'}
        </button>
      </div>
    </div>
  )
}
