import { describe, expect, it } from 'vitest'
import { computeTarget, typeKey } from './calcEntry'

const $ = (d: number) => BigInt(d) * 100n
const ok = (r: ReturnType<typeof computeTarget>) => {
  if (!r.ok) throw new Error(r.message)
  return r
}

describe('phone calculator entry', () => {
  it('1K then + adds to the current bid', () => {
    const r = ok(computeTarget('ADD', '1K', $(1_125_000), $(10_000)))
    expect(r.target).toBe($(1_126_000))
    expect(r.increment).toBe($(1000))
    expect(r.warning).toBeNull()
  })

  it('+ with nothing typed uses the default increment', () => {
    expect(ok(computeTarget('ADD', '', $(900_000), $(10_000))).target).toBe($(910_000))
  })

  it('1.25M then SET sets the bid', () => {
    expect(ok(computeTarget('SET', '1.25M', $(1_125_000), $(10_000))).target).toBe($(1_250_000))
  })

  it('SET opens the auction when there is no bid', () => {
    expect(ok(computeTarget('SET', '850K', null, $(10_000))).target).toBe($(850_000))
  })

  it('rejects + before the first bid, lower SET amounts and bad input', () => {
    expect(computeTarget('ADD', '1K', null, $(10_000)).ok).toBe(false)
    expect(computeTarget('SET', '1M', $(1_125_000), $(10_000)).ok).toBe(false)
    expect(computeTarget('SET', '', $(1_000_000), $(10_000)).ok).toBe(false)
    expect(computeTarget('ADD', '1.2345K', $(1_000_000), $(10_000)).ok).toBe(false)
  })

  it('warns about likely slips (missing K, very big jump)', () => {
    expect(ok(computeTarget('ADD', '5', $(1_000_000), $(10_000))).warning).toMatch(/5K/)
    expect(ok(computeTarget('ADD', '1.25M', $(1_000_000), $(10_000))).warning).toMatch(/Big jump/)
    expect(ok(computeTarget('SET', '950', null, $(10_000))).warning).toMatch(/950K/)
  })

  it('keypad typing stays well-formed', () => {
    let s = ''
    for (const k of ['1', '.', '2', '5', 'M', '5']) s = typeKey(s, k)
    expect(s).toBe('1.25M')
    expect(typeKey('', 'K')).toBe('')
    expect(typeKey('', '.')).toBe('0.')
    expect(typeKey('1.2', '.')).toBe('1.2')
    expect(typeKey('0', '7')).toBe('7')
    expect(typeKey('12', '00')).toBe('1200')
    expect(typeKey('1.25M', '⌫')).toBe('1.25')
    expect(typeKey('1.25M', 'C')).toBe('')
  })
})
