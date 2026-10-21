import { describe, expect, it } from 'vitest'
import { computeTarget, typeKey } from './calcEntry'

const $ = (d: number) => BigInt(d) * 100n
const ok = (r: ReturnType<typeof computeTarget>) => {
  if (!r.ok) throw new Error(r.message)
  return r
}

describe('console calculator entry (no confirmations)', () => {
  it('1K then + adds to the current bid; + alone adds the default increment', () => {
    expect(ok(computeTarget('ADD', '1K', $(1_125_000), $(10_000))).target).toBe($(1_126_000))
    expect(ok(computeTarget('ADD', '', $(900_000), $(10_000))).target).toBe($(910_000))
  })

  it('+ before any bid starts from zero, like a calculator', () => {
    expect(ok(computeTarget('ADD', '500K', null, $(10_000))).target).toBe($(500_000))
  })

  it('SET sets the bid; no warnings for small or big amounts', () => {
    expect(ok(computeTarget('SET', '1.25M', $(1_125_000), $(10_000)))).toMatchObject({ kind: 'BID', target: $(1_250_000) })
    expect(ok(computeTarget('SET', '950', null, $(10_000)))).toMatchObject({ kind: 'BID', target: $(950) })
    expect(ok(computeTarget('ADD', '5', $(1_000_000), $(10_000))).target).toBe($(1_000_005))
  })

  it('SET lower = correct the last bid; SET same = show the price; 0 SET = hide the price', () => {
    expect(ok(computeTarget('SET', '1.1M', $(1_125_000), $(10_000)))).toMatchObject({ kind: 'CORRECT', target: $(1_100_000) })
    expect(ok(computeTarget('SET', '1.125M', $(1_125_000), $(10_000))).kind).toBe('SHOW')
    expect(ok(computeTarget('SET', '0', $(1_125_000), $(10_000))).kind).toBe('HIDE')
    expect(ok(computeTarget('SET', '0', null, $(10_000))).kind).toBe('HIDE')
  })

  it('keeps the money format limits (whole dollars, $100M)', () => {
    expect(computeTarget('ADD', '1.2345K', $(1_000_000), $(10_000)).ok).toBe(false)
    expect(computeTarget('SET', '101M', null, $(10_000)).ok).toBe(false)
    expect(computeTarget('ADD', '1K', $(100_000_000), $(10_000)).ok).toBe(false)
    expect(computeTarget('SET', '', $(1_000_000), $(10_000)).ok).toBe(false)
  })

  it('keypad typing stays well-formed', () => {
    let s = ''
    for (const k of ['1', '.', '2', '5', 'M', '5']) s = typeKey(s, k)
    expect(s).toBe('1.25M')
    expect(typeKey('', 'K')).toBe('')
    expect(typeKey('', '0')).toBe('0')
    expect(typeKey('', '.')).toBe('0.')
    expect(typeKey('1.2', '.')).toBe('1.2')
    expect(typeKey('0', '7')).toBe('7')
    expect(typeKey('12', '00')).toBe('1200')
    expect(typeKey('1.25M', 'C')).toBe('')
  })
})
