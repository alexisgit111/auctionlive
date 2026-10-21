/**
 * Console "calculator" logic — pure, unit tested. One tap, no confirmations:
 *   1K    [+]   → current bid + $1,000 (no bid yet → starts from $0)
 *   [+]          → current bid + the session's default increment
 *   1.25M [SET] → $1,250,000
 *   lower amount [SET] → corrects the last bid to that amount
 *   same amount  [SET] → shows the price again if it was hidden
 *   0     [SET] → hides the price on the room screen (until the next bid)
 * Only the money format is checked (whole dollars, ≤ $100M).
 */
import { parseBidInput, type Cents } from './money'

export type CalcOp = 'ADD' | 'SET'

export type CalcResult =
  | { ok: true; kind: 'BID' | 'CORRECT' | 'HIDE' | 'SHOW'; target: Cents }
  | { ok: false; message: string }

export function computeTarget(op: CalcOp, input: string, current: Cents | null, defaultIncrement: Cents): CalcResult {
  const typed = input.trim()
  if (op === 'ADD') {
    let inc = defaultIncrement
    if (typed) {
      const p = parseBidInput(typed)
      if (!p.ok) return { ok: false, message: p.message }
      inc = p.cents
    }
    const target = (current ?? 0n) + inc
    const max = parseBidInput('100M')
    if (max.ok && target > max.cents) return { ok: false, message: 'Amount exceeds the $100,000,000 safety limit' }
    return { ok: true, kind: 'BID', target }
  }
  if (!typed) return { ok: false, message: 'Type an amount, then press SET' }
  if (/^[0.]+$/.test(typed)) return { ok: true, kind: 'HIDE', target: 0n }
  const p = parseBidInput(typed)
  if (!p.ok) return { ok: false, message: p.message }
  if (current !== null && p.cents === current) return { ok: true, kind: 'SHOW', target: p.cents }
  if (current !== null && p.cents < current) return { ok: true, kind: 'CORRECT', target: p.cents }
  return { ok: true, kind: 'BID', target: p.cents }
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
