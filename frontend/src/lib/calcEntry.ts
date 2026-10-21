/**
 * Phone console "calculator" logic — pure, unit tested.
 *   1K   then [+]   → current bid + $1,000
 *   1.25M then [SET] → $1,250,000
 *   [+] with nothing typed → current bid + the session's default increment
 *   lower amount then [SET] → correction of the last bid (any amount, reason recorded)
 * The result is only a preview; the operator taps the same key again to send it.
 */
import { formatCents, parseBidInput, type Cents } from './money'

export type CalcOp = 'ADD' | 'SET'

export type CalcResult =
  /** kind CORRECT = SET below/at the current bid → replaces the last bid (needs a reason) */
  | { ok: true; kind: 'BID' | 'CORRECT'; target: Cents; increment: Cents | null; warning: string | null }
  | { ok: false; message: string }

const HALF = (c: Cents) => c / 2n

export function computeTarget(op: CalcOp, input: string, current: Cents | null, defaultIncrement: Cents): CalcResult {
  const typed = input.trim()
  if (op === 'ADD') {
    if (current === null) return { ok: false, message: 'No bid yet — type the opening bid and press SET' }
    let inc = defaultIncrement
    if (typed) {
      const p = parseBidInput(typed)
      if (!p.ok) return { ok: false, message: p.message }
      inc = p.cents
    }
    const target = current + inc
    const warning =
      typed && !/[kKmM]/.test(typed) && inc < 100_000n
        ? `Only +${formatCents(inc)} — did you mean ${typed}K?`
        : inc > HALF(current)
          ? `Big jump: +${formatCents(inc)}`
          : null
    return { ok: true, kind: 'BID', target, increment: inc, warning }
  }
  if (!typed) return { ok: false, message: 'Type an amount, then press SET' }
  const p = parseBidInput(typed)
  if (!p.ok) return { ok: false, message: p.message }
  if (current !== null && p.cents === current) return { ok: false, message: `Already ${formatCents(current)}` }
  if (current !== null && p.cents < current)
    return { ok: true, kind: 'CORRECT', target: p.cents, increment: p.cents - current, warning: 'Lower than the current bid — corrects the last bid' }
  const warning =
    current !== null && p.cents - current > HALF(current)
      ? `Big jump: +${formatCents(p.cents - current)}`
      : current === null && p.cents < 1_000_000n
        ? `Opening bid only ${formatCents(p.cents)} — did you mean ${typed}K?`
        : null
  return { ok: true, kind: 'BID', target: p.cents, increment: current === null ? null : p.cents - current, warning }
}

/** Apply a keypad key to the typed text (keeps it short and well-formed). */
export function typeKey(input: string, key: string): string {
  if (key === 'C') return ''
  if (key === '⌫') return input.slice(0, -1)
  if (/[KM]$/.test(input)) return input // nothing after the K/M suffix
  if (key === 'K' || key === 'M') return input && input !== '.' ? input + key : input
  if (key === '.') return input.includes('.') ? input : (input || '0') + '.'
  if (key === '00') return input && !/^0$/.test(input) ? (input + '00').slice(0, 12) : input
  if (/^[0-9]$/.test(key)) return input === '0' ? key : (input + key).slice(0, 12)
  return input
}
