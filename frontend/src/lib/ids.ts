const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function rand(n: number): Uint8Array {
  const a = new Uint8Array(n)
  crypto.getRandomValues(a)
  return a
}

/** ULID-like sortable id (26 chars). */
export function ulid(now = Date.now()): string {
  let t = now
  let time = ''
  for (let i = 0; i < 10; i++) {
    time = B32[t % 32] + time
    t = Math.floor(t / 32)
  }
  const r = rand(16)
  let tail = ''
  for (let i = 0; i < 16; i++) tail += B32[r[i] % 32]
  return time + tail
}

export const uuid = (): string => crypto.randomUUID()

/** Human-friendly pairing code without ambiguous characters (no 0/O, 1/I/L). */
export function pairingCode(len = 6): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const r = rand(len)
  let s = ''
  for (let i = 0; i < len; i++) s += alphabet[r[i] % alphabet.length]
  return s
}

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
