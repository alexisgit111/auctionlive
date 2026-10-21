import { describe, expect, it } from 'vitest'
import { allowedCommands, applyCommand, initialState } from './engine'
import { FORBIDDEN_PUBLIC_KEYS, derivePublicStatus, toPublicState } from './publicState'
import { initialSync, reduceSync } from './displaySync'
import type { AuctionState, Bid, Command, PublicDisplayState, Session } from './types'

let n = 0
const ctx = () => ({ operatorId: 'u1', now: '2026-10-16T00:00:00.000Z', idempotencyKey: `k${++n}`, newId: () => `b${++n}` })

function run(cmds: Command[]) {
  let state: AuctionState = initialState('s1', 'now')
  let bids: Bid[] = []
  const events = []
  for (const c of cmds) {
    const r = applyCommand(state, bids, c, ctx())
    state = r.state
    bids = r.bids
    events.push(...r.events)
  }
  return { state, bids, events }
}

const K = (k: number) => (BigInt(k) * 1000n * 100n).toString()

describe('state machine', () => {
  it('keeps session status and sale status separate', () => {
    const { state } = run([{ type: 'START' }, { type: 'BID', amountCents: K(900) }, { type: 'ON_THE_MARKET' }])
    expect(state.sessionStatus).toBe('LIVE')
    expect(state.saleStatus).toBe('ON_THE_MARKET')
  })

  it('can take a property off the market again', () => {
    const { state, events } = run([{ type: 'START' }, { type: 'ON_THE_MARKET' }, { type: 'OFF_MARKET' }])
    expect(state.saleStatus).toBe('NONE')
    expect(events.map((e) => e.type)).toEqual(['AUCTION_STARTED', 'ON_THE_MARKET', 'OFF_THE_MARKET'])
    expect(allowedCommands(state).has('ON_THE_MARKET')).toBe(true)
    expect(() => run([{ type: 'START' }, { type: 'OFF_MARKET' }])).toThrow(/not on the market/)
  })

  it('hides and shows the display stickers, and a new status brings them back', () => {
    const hidden = run([{ type: 'START' }, { type: 'ON_THE_MARKET' }, { type: 'SET_OVERLAY', hidden: true }])
    expect(hidden.state.overlayHidden).toBe(true)
    expect(hidden.events.at(-1)!.type).toBe('OVERLAY_HIDDEN')
    expect(toPublicState({ property: { addressLine: '', suburb: '', city: '', heroImage: null }, salespeople: [] } as unknown as Session, hidden.state, 'now').overlayHidden).toBe(true)
    // a bid keeps them hidden, a status change shows them again
    const bid = run([{ type: 'START' }, { type: 'SET_OVERLAY', hidden: true }, { type: 'BID', amountCents: K(900) }])
    expect(bid.state.overlayHidden).toBe(true)
    const sold = run([{ type: 'START' }, { type: 'BID', amountCents: K(900) }, { type: 'SET_OVERLAY', hidden: true }, { type: 'SOLD' }])
    expect(sold.state.overlayHidden).toBe(false)
    const shown = run([{ type: 'START' }, { type: 'SET_OVERLAY', hidden: true }, { type: 'SET_OVERLAY', hidden: false }])
    expect(shown.state.overlayHidden).toBe(false)
    expect(() => run([{ type: 'START' }, { type: 'SET_OVERLAY', hidden: false }])).toThrow(/already shown/)
  })

  it('increments state version and event seq on every mutation', () => {
    const { state, events } = run([{ type: 'START' }, { type: 'BID', amountCents: K(900) }, { type: 'PAUSE' }])
    expect(state.stateVersion).toBe(3)
    expect(events.map((e) => e.stateVersion)).toEqual([1, 2, 3])
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('requires strictly higher bids', () => {
    const { state, bids } = run([{ type: 'START' }, { type: 'BID', amountCents: K(1275) }])
    expect(() => applyCommand(state, bids, { type: 'BID', amountCents: K(1275) }, ctx())).toThrow(/higher/)
    expect(() => applyCommand(state, bids, { type: 'BID', amountCents: K(1270) }, ctx())).toThrow(/higher/)
  })

  it.each([
    ['NOT_STARTED', [] as Command[]],
    ['PAUSED', [{ type: 'START' }, { type: 'PAUSE' }] as Command[]],
    ['ENDED', [{ type: 'START' }, { type: 'END' }] as Command[]],
    ['SOLD', [{ type: 'START' }, { type: 'BID', amountCents: K(1) }, { type: 'SOLD' }] as Command[]],
    ['PASSED_IN', [{ type: 'START' }, { type: 'PASSED_IN' }] as Command[]],
  ])('rejects bids when %s', (_, cmds) => {
    const { state, bids } = run(cmds)
    expect(() => applyCommand(state, bids, { type: 'BID', amountCents: K(5000) }, ctx())).toThrow()
  })

  it('refuses SOLD without a bid', () => {
    const { state, bids } = run([{ type: 'START' }])
    expect(() => applyCommand(state, bids, { type: 'SOLD' }, ctx())).toThrow(/without an accepted bid/)
  })

  it('SOLD ends the session and records the sold amount', () => {
    const { state, events } = run([{ type: 'START' }, { type: 'BID', amountCents: K(1275) }, { type: 'SOLD' }])
    expect(state.sessionStatus).toBe('ENDED')
    expect(state.saleStatus).toBe('SOLD')
    expect(events.at(-1)!.data).toMatchObject({ soldCents: K(1275) })
  })

  it('undo requires reason, is append-only, and restores the previous bid', () => {
    const { state, bids } = run([{ type: 'START' }, { type: 'BID', amountCents: K(1000) }, { type: 'BID', amountCents: K(1100) }])
    expect(() => applyCommand(state, bids, { type: 'UNDO', bidId: state.currentBidId!, reason: '  ' }, ctx())).toThrow(/reason/)
    const r = applyCommand(state, bids, { type: 'UNDO', bidId: state.currentBidId!, reason: 'Wrong amount' }, ctx())
    expect(r.state.currentBidCents).toBe(K(1000))
    expect(r.bids).toHaveLength(2) // nothing deleted
    expect(r.bids.find((b) => b.amountCents === K(1100))!.status).toBe('REVERSED')
    expect(r.events[0].reason).toBe('Wrong amount')
  })

  it('only the latest bid can be undone', () => {
    const { state, bids } = run([{ type: 'START' }, { type: 'BID', amountCents: K(1000) }, { type: 'BID', amountCents: K(1100) }])
    const first = bids.find((b) => b.amountCents === K(1000))!
    expect(() => applyCommand(state, bids, { type: 'UNDO', bidId: first.id, reason: 'x' }, ctx())).toThrow(/latest/)
  })

  it('correction can be any amount — even below the previous bid', () => {
    const { state, bids } = run([{ type: 'START' }, { type: 'BID', amountCents: K(1000) }, { type: 'BID', amountCents: K(1200) }])
    const low = applyCommand(state, bids, { type: 'CORRECT', bidId: state.currentBidId!, amountCents: K(950), reason: 'misheard' }, ctx())
    expect(low.state.currentBidCents).toBe(K(950))
    expect(() =>
      applyCommand(state, bids, { type: 'CORRECT', bidId: state.currentBidId!, amountCents: K(1200), reason: 'same' }, ctx()),
    ).toThrow(/same/)
    // the next bid must beat the corrected amount
    expect(() => applyCommand(low.state, low.bids, { type: 'BID', amountCents: K(950) }, ctx())).toThrow(/higher/)
    expect(applyCommand(low.state, low.bids, { type: 'BID', amountCents: K(960) }, ctx()).state.currentBidCents).toBe(K(960))
  })

  it('reopen undoes SOLD / PASSED IN / END and restores where the auction was', () => {
    const sold = run([{ type: 'START' }, { type: 'BID', amountCents: K(1000) }, { type: 'ON_THE_MARKET' }, { type: 'SOLD' }])
    expect(allowedCommands(sold.state).has('REOPEN')).toBe(true)
    expect(() => applyCommand(sold.state, sold.bids, { type: 'REOPEN', reason: ' ' }, ctx())).toThrow(/reason/)
    const r = applyCommand(sold.state, sold.bids, { type: 'REOPEN', reason: 'Pressed by mistake' }, ctx())
    expect(r.state.sessionStatus).toBe('LIVE')
    expect(r.state.saleStatus).toBe('ON_THE_MARKET')
    expect(r.state.currentBidCents).toBe(K(1000))
    expect(r.events[0].type).toBe('REOPENED')
    expect(r.events[0].reason).toBe('Pressed by mistake')
    // bidding continues
    expect(applyCommand(r.state, r.bids, { type: 'BID', amountCents: K(1010) }, ctx()).state.currentBidCents).toBe(K(1010))
    // passed in while paused → back to paused
    const pi = run([{ type: 'START' }, { type: 'PAUSE' }, { type: 'PASSED_IN' }])
    const back = applyCommand(pi.state, pi.bids, { type: 'REOPEN', reason: 'x' }, ctx())
    expect(back.state.sessionStatus).toBe('PAUSED')
    expect(back.state.saleStatus).toBe('NONE')
    // only after the auction has ended
    const live = run([{ type: 'START' }])
    expect(() => applyCommand(live.state, live.bids, { type: 'REOPEN', reason: 'x' }, ctx())).toThrow(/not ended/)
  })

  it('correction supersedes the original', () => {
    const { state, bids } = run([{ type: 'START' }, { type: 'BID', amountCents: K(1000) }, { type: 'BID', amountCents: K(1200) }])
    const r = applyCommand(state, bids, { type: 'CORRECT', bidId: state.currentBidId!, amountCents: K(1020), reason: 'typo' }, ctx())
    expect(r.state.currentBidCents).toBe(K(1020))
    expect(r.bids).toHaveLength(3)
    const corrected = r.bids.find((b) => b.amountCents === K(1200))!
    expect(corrected.status).toBe('CORRECTED')
    expect(r.bid!.supersedesBidId).toBe(corrected.id)
    expect(r.events[0].data).toMatchObject({ fromCents: K(1200), toCents: K(1020) })
  })

  it('reports allowed commands for the UI', () => {
    expect([...allowedCommands(initialState('s', 'n'))]).toEqual(['START'])
    const { state } = run([{ type: 'START' }])
    const a = allowedCommands(state)
    expect(a.has('BID')).toBe(true)
    expect(a.has('SOLD')).toBe(false)
  })
})

describe('public display serializer', () => {
  const session: Session = {
    id: 's1',
    title: 't',
    scheduledAt: 'x',
    auctioneerName: 'Secret Auctioneer',
    salespeople: [
      { name: 'Jane Smith', photo: 'idb-image:photo' },
      { name: 'Li Wei', photo: null },
      { name: 'Third Person', photo: null },
    ],
    defaultIncrementCents: '100',
    reserveCents: '999999900',
    internalNotes: 'VENDOR WILL ACCEPT 1.2M',
    property: { addressLine: '1 Road', suburb: 'Sub', city: 'Akl', heroImage: null, bedrooms: 3, bathrooms: 1, parking: 1, landAreaM2: 500, floorAreaM2: null, badge: '' },
    createdAt: 'x',
    createdBy: 'u',
  }

  it('contains no forbidden keys or private values anywhere', () => {
    const { state } = run([{ type: 'START' }, { type: 'BID', amountCents: K(1275) }])
    const pub = toPublicState(session, state, 'now')
    const json = JSON.stringify(pub)
    const keys = new Set<string>()
    const walk = (o: unknown) => {
      if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) (keys.add(k), walk(v))
    }
    walk(pub)
    for (const f of FORBIDDEN_PUBLIC_KEYS) expect(keys.has(f)).toBe(false)
    expect(json).not.toContain('999999900')
    expect(json).not.toContain('VENDOR')
    expect(json).not.toContain('Secret Auctioneer')
    expect(pub.salespeople).toEqual([
      { name: 'Jane Smith', photo: 'idb-image:photo' },
      { name: 'Li Wei', photo: null },
    ])
    expect(pub.currentBidDisplay).toBe('$1,275,000')
  })

  it('derives public status', () => {
    expect(derivePublicStatus({ sessionStatus: 'LIVE', saleStatus: 'ON_THE_MARKET' })).toBe('ON_THE_MARKET')
    expect(derivePublicStatus({ sessionStatus: 'PAUSED', saleStatus: 'ON_THE_MARKET' })).toBe('PAUSED')
    expect(derivePublicStatus({ sessionStatus: 'ENDED', saleStatus: 'SOLD' })).toBe('SOLD')
  })
})

describe('display sync reducer', () => {
  const st = (v: number) => ({ stateVersion: v }) as PublicDisplayState

  it('starts from a snapshot, applies sequential messages, ignores stale & duplicates', () => {
    let s = reduceSync(initialSync, { kind: 'snapshot', state: st(3) }).next
    let r = reduceSync(s, { kind: 'message', state: st(4) })
    expect(r.outcome).toBe('applied')
    s = r.next
    expect(reduceSync(s, { kind: 'message', state: st(4) }).outcome).toBe('ignored-stale') // duplicate
    expect(reduceSync(s, { kind: 'message', state: st(2) }).outcome).toBe('ignored-stale') // out of order
  })

  it('detects gaps', () => {
    const s = reduceSync(initialSync, { kind: 'snapshot', state: st(3) }).next
    expect(reduceSync(s, { kind: 'message', state: st(5) }).outcome).toBe('gap')
  })

  it('ignores a late snapshot older than what is on screen', () => {
    const s = reduceSync(initialSync, { kind: 'snapshot', state: st(7) }).next
    expect(reduceSync(s, { kind: 'snapshot', state: st(6) }).outcome).toBe('ignored-stale')
  })

  it('takes the snapshot of a new session when the screen is moved (versions restart there)', () => {
    const at = (sessionId: string, v: number) => ({ sessionId, stateVersion: v }) as PublicDisplayState
    const s = reduceSync(initialSync, { kind: 'snapshot', state: at('A', 40) }).next
    expect(reduceSync(s, { kind: 'message', state: at('B', 3) }).outcome).toBe('gap')
    const r = reduceSync(s, { kind: 'snapshot', state: at('B', 3) })
    expect(r.outcome).toBe('applied')
    expect(r.next.appliedVersion).toBe(3)
  })

  it('requires a snapshot before applying messages', () => {
    expect(reduceSync(initialSync, { kind: 'message', state: st(1) }).outcome).toBe('gap')
  })
})
