import { describe, expect, it } from 'vitest'
import { formatCents, formatCompact, parseBidInput } from './money'

const ok = (s: string) => {
  const r = parseBidInput(s)
  if (!r.ok) throw new Error(`expected ok for "${s}", got ${r.error}`)
  return r.cents
}
const err = (s: string) => {
  const r = parseBidInput(s)
  if (r.ok) throw new Error(`expected failure for "${s}", got ${r.cents}`)
  return r.error
}

describe('parseBidInput — accepted forms (spec §2)', () => {
  it.each(['1275K', '1275k', '1275 K', '1.275M', '1.275m', '1275000', ' 1275000 ', '1,275,000', '1.2750M', '1275.000K'])(
    '%s → $1,275,000',
    (s) => {
      expect(ok(s)).toBe(127_500_000n)
    },
  )

  it('handles small and large values exactly', () => {
    expect(ok('1')).toBe(100n)
    expect(ok('950K')).toBe(95_000_000n)
    expect(ok('2M')).toBe(200_000_000n)
    expect(ok('0.5M')).toBe(50_000_000n)
    expect(ok('12.345678M')).toBe(1_234_567_800n)
    expect(ok('100M')).toBe(10_000_000_000n)
  })

  it('never uses floating point (0.1 + 0.2 class cases are exact)', () => {
    expect(ok('1.1M') + ok('2.2M')).toBe(ok('3.3M'))
  })
})

describe('parseBidInput — rejected forms', () => {
  it.each([
    ['', 'EMPTY'],
    ['   ', 'EMPTY'],
    ['-5K', 'INVALID_CHARACTERS'],
    ['$1M', 'INVALID_CHARACTERS'],
    ['1e6', 'INVALID_CHARACTERS'],
    ['1M+', 'INVALID_CHARACTERS'],
    ['abc', 'INVALID_CHARACTERS'],
    ['1..2M', 'MALFORMED_NUMBER'],
    ['1.2.3', 'MALFORMED_NUMBER'],
    ['.5M', 'MALFORMED_NUMBER'],
    ['1.M', 'MALFORMED_NUMBER'],
    ['1KM', 'MALFORMED_NUMBER'],
    ['K', 'MALFORMED_NUMBER'],
    ['01275K', 'MALFORMED_NUMBER'],
    ['1,27,5000', 'MALFORMED_NUMBER'],
    ['1 275 000', 'MALFORMED_NUMBER'],
    ['1.2345K', 'TOO_MANY_DECIMALS'],
    ['1.2345678M', 'TOO_MANY_DECIMALS'],
    ['1275000.50', 'NOT_WHOLE_DOLLARS'],
    ['0', 'ZERO'],
    ['0K', 'ZERO'],
    ['100.000001M', 'TOO_LARGE'],
    ['101M', 'TOO_LARGE'],
    ['9999999999999', 'TOO_LARGE'],
  ])('%s → %s', (s, code) => {
    expect(err(s)).toBe(code)
  })
})

describe('formatting', () => {
  it('formats cents', () => {
    expect(formatCents(127_500_000n)).toBe('$1,275,000')
    expect(formatCents('105')).toBe('$1.05')
    expect(formatCents(null)).toBe('—')
  })
  it('formats compact', () => {
    expect(formatCompact(127_500_000n)).toBe('1,275K')
    expect(formatCompact(200_000_000n)).toBe('2M')
  })
})
