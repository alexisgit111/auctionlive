/**
 * Money handling for Auction Live.
 *
 * Authoritative amounts are integer cents held as `bigint` in memory and as
 * decimal digit strings in storage / over the wire. No floating point is used
 * anywhere in parsing, comparison or arithmetic.
 */

export type Cents = bigint

/** Hard safety ceiling: NZ$100,000,000. Configurable per environment later. */
export const MAX_BID_CENTS: Cents = 100_000_000_00n

export type ParseError =
  | 'EMPTY'
  | 'INVALID_CHARACTERS'
  | 'MALFORMED_NUMBER'
  | 'TOO_MANY_DECIMALS'
  | 'NOT_WHOLE_DOLLARS'
  | 'ZERO'
  | 'TOO_LARGE'

export type ParseResult = { ok: true; cents: Cents } | { ok: false; error: ParseError; message: string }

const MESSAGES: Record<ParseError, string> = {
  EMPTY: 'Enter an amount',
  INVALID_CHARACTERS: 'Only digits, one decimal point and K or M are allowed',
  MALFORMED_NUMBER: 'That number is not well formed',
  TOO_MANY_DECIMALS: 'Too many decimal places for that unit',
  NOT_WHOLE_DOLLARS: 'Bids must be whole dollars',
  ZERO: 'Amount must be greater than zero',
  TOO_LARGE: 'Amount exceeds the $100,000,000 safety limit',
}

const fail = (error: ParseError): ParseResult => ({ ok: false, error, message: MESSAGES[error] })

/**
 * Parse operator input into integer cents.
 *
 * Accepts: `1275000`, `1275K`, `1275k`, `1275 K`, `1.275M`, `1.275m`, `1,275,000`
 * Rejects: negatives, currency symbols, exponents, multiple dots, leading zeros,
 *          fractional dollars, zero, values over the safety ceiling.
 */
export function parseBidInput(raw: string): ParseResult {
  const input = raw.trim()
  if (input === '') return fail('EMPTY')

  // Only digits, commas, a dot, spaces and a K/M suffix may appear at all.
  if (!/^[0-9.,\skKmM]+$/.test(input)) return fail('INVALID_CHARACTERS')

  const m = /^([0-9][0-9,]*)(?:\.([0-9]+))?\s*([kKmM])?$/.exec(input)
  if (!m) return fail('MALFORMED_NUMBER')

  let [, intPart, frac = '', suffix] = m

  // Commas are allowed only as correct thousands separators, and only without decimals/suffix ambiguity.
  if (intPart.includes(',')) {
    if (!/^[1-9][0-9]{0,2}(,[0-9]{3})+$/.test(intPart)) return fail('MALFORMED_NUMBER')
    intPart = intPart.replace(/,/g, '')
  }

  // No leading zeros on multi-digit integers ("01275K" is suspicious input).
  if (intPart.length > 1 && intPart.startsWith('0')) return fail('MALFORMED_NUMBER')

  // Guard absurd digit counts before BigInt work.
  if (intPart.length > 12 || frac.length > 12) return fail('TOO_LARGE')

  const unitExp = suffix === undefined ? 0 : suffix.toLowerCase() === 'k' ? 3 : 6
  // Dollars = (intPart.frac) * 10^unitExp ; we need it to be an integer number of dollars.
  if (frac.length > unitExp) {
    // Extra digits are allowed only if they are zeros (e.g. "1.2500M" is fine, "1.2345K" is not).
    const extra = frac.slice(unitExp)
    if (!/^0+$/.test(extra)) return fail(unitExp === 0 ? 'NOT_WHOLE_DOLLARS' : 'TOO_MANY_DECIMALS')
    frac = frac.slice(0, unitExp)
  }
  const fracPadded = frac.padEnd(unitExp, '0')
  const dollars = BigInt(intPart + fracPadded) // exact
  const cents = dollars * 100n

  if (cents === 0n) return fail('ZERO')
  if (cents > MAX_BID_CENTS) return fail('TOO_LARGE')
  return { ok: true, cents }
}

/** "$1,275,000" — cents shown only when non-zero. */
export function formatCents(cents: Cents | string | null | undefined): string {
  if (cents === null || cents === undefined || cents === '') return '—'
  const c = typeof cents === 'string' ? BigInt(cents) : cents
  const neg = c < 0n
  const abs = neg ? -c : c
  const dollars = abs / 100n
  const rem = abs % 100n
  const grouped = dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const tail = rem === 0n ? '' : '.' + rem.toString().padStart(2, '0')
  return `${neg ? '-' : ''}$${grouped}${tail}`
}

/** Compact operator-facing form: 1275000 dollars → "1,275K", 2,000,000 → "2M". */
export function formatCompact(cents: Cents | string): string {
  const c = typeof cents === 'string' ? BigInt(cents) : cents
  const dollars = c / 100n
  if (dollars >= 1_000_000n && dollars % 1_000_000n === 0n) return `${dollars / 1_000_000n}M`
  if (dollars >= 1000n && dollars % 1000n === 0n)
    return `${(dollars / 1000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}K`
  return formatCents(c)
}

export const toCents = (s: string | null | undefined): Cents | null => (s == null ? null : BigInt(s))
export const centsStr = (c: Cents): string => c.toString()
export const dollarsToCents = (d: number | bigint): Cents => BigInt(d) * 100n
