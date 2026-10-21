/**
 * Pure, deterministic auction state machine. No I/O, no clocks, no randomness:
 * everything external arrives via `ctx`. The same rules will be ported 1:1 to
 * the Laravel AuctionCommandService in Phase 1B, and these tests become the
 * shared contract.
 */
import type { AuctionEvent, AuctionState, Bid, Command, EventType, StateSnapshot } from './types'
import { ApiError, DEFAULT_VOLUME } from './types'

export interface CommandContext {
  operatorId: string
  now: string
  idempotencyKey: string
  newId: () => string
}

export interface CommandResult {
  state: AuctionState
  bids: Bid[]
  events: AuctionEvent[]
  bid?: Bid
}

export const snapshot = (s: AuctionState): StateSnapshot => ({
  sessionStatus: s.sessionStatus,
  saleStatus: s.saleStatus,
  currentBidId: s.currentBidId,
  currentBidCents: s.currentBidCents,
  bidCount: s.bidCount,
  stateVersion: s.stateVersion,
})

export function initialState(sessionId: string, now: string): AuctionState {
  return {
    sessionId,
    sessionStatus: 'NOT_STARTED',
    saleStatus: 'NONE',
    currentBidId: null,
    currentBidCents: null,
    bidCount: 0,
    stateVersion: 0,
    eventSeq: 0,
    updatedAt: now,
    overlayHidden: false,
    welcomeOn: false,
    musicOn: false,
    volume: DEFAULT_VOLUME,
  }
}

const transition = (msg: string) => new ApiError('INVALID_TRANSITION', msg, 409)

const saleOpen = (s: AuctionState) => s.saleStatus === 'NONE' || s.saleStatus === 'ON_THE_MARKET'

export const activeBids = (bids: Bid[]) => bids.filter((b) => b.status === 'ACTIVE').sort((a, b) => a.seq - b.seq)

function recomputeCurrent(state: AuctionState, bids: Bid[]): AuctionState {
  const active = activeBids(bids)
  const top = active[active.length - 1]
  return {
    ...state,
    currentBidId: top?.id ?? null,
    currentBidCents: top?.amountCents ?? null,
    bidCount: active.length,
  }
}

/** Which commands are currently allowed — drives button enablement in the UI. */
export function allowedCommands(s: AuctionState): Set<Command['type']> {
  const a = new Set<Command['type']>()
  if (s.sessionStatus === 'NOT_STARTED') a.add('START')
  if (s.sessionStatus === 'LIVE' && saleOpen(s)) {
    a.add('BID')
    a.add('PAUSE')
    if (s.saleStatus === 'NONE') a.add('ON_THE_MARKET')
  }
  if (s.sessionStatus === 'PAUSED') a.add('RESUME')
  if ((s.sessionStatus === 'LIVE' || s.sessionStatus === 'PAUSED') && s.saleStatus === 'ON_THE_MARKET') a.add('OFF_MARKET')
  if (s.sessionStatus !== 'NOT_STARTED') a.add('SET_OVERLAY')
  if (s.sessionStatus === 'ENDED') a.add('REOPEN')
  a.add('SET_WELCOME')
  a.add('SET_MUSIC')
  a.add('SET_VOLUME')
  if ((s.sessionStatus === 'LIVE' || s.sessionStatus === 'PAUSED') && saleOpen(s)) {
    if (s.bidCount > 0) a.add('SOLD')
    a.add('PASSED_IN')
    a.add('END')
    if (s.bidCount > 0) {
      a.add('UNDO')
      a.add('CORRECT')
    }
  }
  return a
}

export function applyCommand(state: AuctionState, bids: Bid[], cmd: Command, ctx: CommandContext): CommandResult {
  const prev = state
  let next: AuctionState = { ...state }
  let nextBids = bids
  let type: EventType
  let reason: string | null = null
  let data: AuctionEvent['data'] = null
  let newBid: Bid | undefined

  switch (cmd.type) {
    case 'START':
      if (state.sessionStatus !== 'NOT_STARTED') throw transition('Auction has already started')
      next.sessionStatus = 'LIVE'
      type = 'AUCTION_STARTED'
      break

    case 'PAUSE':
      if (state.sessionStatus !== 'LIVE') throw transition('Only a live auction can be paused')
      if (!saleOpen(state)) throw transition('Sale is already concluded')
      next.sessionStatus = 'PAUSED'
      type = 'PAUSED'
      break

    case 'RESUME':
      if (state.sessionStatus !== 'PAUSED') throw transition('Auction is not paused')
      next.sessionStatus = 'LIVE'
      type = 'RESUMED'
      break

    case 'ON_THE_MARKET':
      if (state.sessionStatus !== 'LIVE') throw transition('Auction must be live')
      if (state.saleStatus !== 'NONE') throw transition('Property is already on the market or concluded')
      next.saleStatus = 'ON_THE_MARKET'
      type = 'ON_THE_MARKET'
      break

    case 'OFF_MARKET':
      if (state.sessionStatus !== 'LIVE' && state.sessionStatus !== 'PAUSED') throw transition('Auction is not running')
      if (state.saleStatus !== 'ON_THE_MARKET') throw transition('Property is not on the market')
      next.saleStatus = 'NONE'
      type = 'OFF_THE_MARKET'
      break

    case 'SET_OVERLAY':
      if (state.sessionStatus === 'NOT_STARTED') throw transition('Auction has not started')
      if (!!state.overlayHidden === !!cmd.hidden)
        throw transition(cmd.hidden ? 'Stickers are already hidden' : 'Stickers are already shown')
      next.overlayHidden = !!cmd.hidden
      type = cmd.hidden ? 'OVERLAY_HIDDEN' : 'OVERLAY_SHOWN'
      break

    case 'SOLD':
      if (state.sessionStatus !== 'LIVE' && state.sessionStatus !== 'PAUSED') throw transition('Auction is not running')
      if (!saleOpen(state)) throw transition('Sale is already concluded')
      if (state.bidCount === 0 || !state.currentBidCents) throw transition('Cannot mark sold without an accepted bid')
      next.concludedFrom = { sessionStatus: state.sessionStatus, saleStatus: state.saleStatus }
      next.saleStatus = 'SOLD'
      next.sessionStatus = 'ENDED'
      type = 'SOLD'
      data = { soldCents: state.currentBidCents, soldBidId: state.currentBidId }
      break

    case 'PASSED_IN':
      if (state.sessionStatus !== 'LIVE' && state.sessionStatus !== 'PAUSED') throw transition('Auction is not running')
      if (!saleOpen(state)) throw transition('Sale is already concluded')
      next.concludedFrom = { sessionStatus: state.sessionStatus, saleStatus: state.saleStatus }
      next.saleStatus = 'PASSED_IN'
      next.sessionStatus = 'ENDED'
      type = 'PASSED_IN'
      data = { highestCents: state.currentBidCents }
      break

    case 'END':
      if (state.sessionStatus !== 'LIVE' && state.sessionStatus !== 'PAUSED') throw transition('Auction is not running')
      next.concludedFrom = { sessionStatus: state.sessionStatus, saleStatus: state.saleStatus }
      next.sessionStatus = 'ENDED'
      type = 'AUCTION_ENDED'
      break

    case 'SET_WELCOME':
      if (!!state.welcomeOn === !!cmd.on) throw transition(cmd.on ? 'Welcome screen is already on' : 'Welcome screen is already off')
      next.welcomeOn = !!cmd.on
      type = cmd.on ? 'WELCOME_SHOWN' : 'WELCOME_HIDDEN'
      break

    case 'SET_MUSIC':
      if (!!state.musicOn === !!cmd.on) throw transition(cmd.on ? 'Music is already playing' : 'Music is already off')
      next.musicOn = !!cmd.on
      type = cmd.on ? 'MUSIC_STARTED' : 'MUSIC_STOPPED'
      break

    case 'SET_VOLUME': {
      const v = Math.round(Number(cmd.percent))
      if (!Number.isFinite(v) || v < 0 || v > 100) throw new ApiError('VALIDATION_FAILED', 'Volume must be 0–100', 422)
      if (v === (state.volume ?? DEFAULT_VOLUME)) throw transition('Volume unchanged')
      next.volume = v
      type = 'VOLUME_SET'
      data = { volume: v }
      break
    }

    case 'REOPEN': {
      // Undo Sold / Passed in / End: back to exactly where the auction was. Bids are untouched.
      if (state.sessionStatus !== 'ENDED') throw transition('Auction has not ended')
      if (!cmd.reason?.trim()) throw new ApiError('VALIDATION_FAILED', 'A reason is required to reopen the auction', 422)
      const back = state.concludedFrom ?? { sessionStatus: 'PAUSED' as const, saleStatus: 'NONE' as const }
      next.sessionStatus = back.sessionStatus === 'LIVE' || back.sessionStatus === 'PAUSED' ? back.sessionStatus : 'PAUSED'
      next.saleStatus = back.saleStatus === 'ON_THE_MARKET' ? 'ON_THE_MARKET' : 'NONE'
      next.concludedFrom = null
      type = 'REOPENED'
      reason = cmd.reason.trim()
      data = { fromSaleStatus: state.saleStatus }
      break
    }

    case 'BID': {
      if (state.sessionStatus !== 'LIVE') throw transition('Bids can only be entered while the auction is live')
      if (!saleOpen(state)) throw transition('Sale is already concluded')
      if (!/^[1-9][0-9]*$/.test(cmd.amountCents)) throw new ApiError('INVALID_AMOUNT', 'Invalid amount', 400)
      const amount = BigInt(cmd.amountCents)
      if (amount % 100n !== 0n) throw new ApiError('INVALID_AMOUNT', 'Bids must be whole dollars', 400)
      if (state.currentBidCents !== null && amount <= BigInt(state.currentBidCents))
        throw new ApiError('BID_NOT_HIGHER', 'Bid must be higher than the current bid', 409, {
          currentBidCents: state.currentBidCents,
        })
      const seq = bids.reduce((m, b) => Math.max(m, b.seq), 0) + 1
      newBid = {
        id: ctx.newId(),
        sessionId: state.sessionId,
        seq,
        amountCents: amount.toString(),
        status: 'ACTIVE',
        supersedesBidId: null,
        operatorId: ctx.operatorId,
        idempotencyKey: ctx.idempotencyKey,
        source: 'CLOUD',
        createdAt: ctx.now,
      }
      nextBids = [...bids, newBid]
      next = recomputeCurrent(next, nextBids)
      type = 'BID_ACCEPTED'
      data = { bidId: newBid.id, bidSeq: seq, amountCents: newBid.amountCents }
      break
    }

    case 'UNDO': {
      if (state.sessionStatus !== 'LIVE' && state.sessionStatus !== 'PAUSED') throw transition('Auction is not running')
      if (!saleOpen(state)) throw transition('Sale is already concluded')
      if (!cmd.reason.trim()) throw new ApiError('VALIDATION_FAILED', 'A reason is required to undo a bid', 422)
      if (cmd.bidId !== state.currentBidId) throw transition('Only the latest accepted bid can be undone')
      nextBids = bids.map((b) => (b.id === cmd.bidId ? { ...b, status: 'REVERSED' as const } : b))
      next = recomputeCurrent(next, nextBids)
      type = 'BID_UNDONE'
      reason = cmd.reason.trim()
      data = { bidId: cmd.bidId, amountCents: state.currentBidCents }
      break
    }

    case 'CORRECT': {
      if (state.sessionStatus !== 'LIVE' && state.sessionStatus !== 'PAUSED') throw transition('Auction is not running')
      if (!saleOpen(state)) throw transition('Sale is already concluded')
      if (!cmd.reason.trim()) throw new ApiError('VALIDATION_FAILED', 'A reason is required to correct a bid', 422)
      if (cmd.bidId !== state.currentBidId) throw transition('Only the latest accepted bid can be corrected')
      if (!/^[1-9][0-9]*$/.test(cmd.amountCents)) throw new ApiError('INVALID_AMOUNT', 'Invalid amount', 400)
      const amount = BigInt(cmd.amountCents)
      if (amount % 100n !== 0n) throw new ApiError('INVALID_AMOUNT', 'Bids must be whole dollars', 400)
      if (amount.toString() === state.currentBidCents)
        throw new ApiError('VALIDATION_FAILED', 'Corrected amount is the same as the original', 422)
      // Any amount is allowed (higher or lower) — the original stays in the record as CORRECTED.
      const original = bids.find((b) => b.id === cmd.bidId)!
      const seq = bids.reduce((m, b) => Math.max(m, b.seq), 0) + 1
      newBid = {
        id: ctx.newId(),
        sessionId: state.sessionId,
        seq,
        amountCents: amount.toString(),
        status: 'ACTIVE',
        supersedesBidId: original.id,
        operatorId: ctx.operatorId,
        idempotencyKey: ctx.idempotencyKey,
        source: 'CLOUD',
        createdAt: ctx.now,
      }
      nextBids = [...bids.map((b) => (b.id === original.id ? { ...b, status: 'CORRECTED' as const } : b)), newBid]
      next = recomputeCurrent(next, nextBids)
      type = 'BID_CORRECTED'
      reason = cmd.reason.trim()
      data = { originalBidId: original.id, fromCents: original.amountCents, toCents: newBid.amountCents, bidId: newBid.id }
      break
    }
  }

  // Any new status (on the market, sold, paused…) brings the stickers back so the room sees it.
  if (cmd.type !== 'SET_OVERLAY') {
    next.overlayHidden =
      next.sessionStatus !== state.sessionStatus || next.saleStatus !== state.saleStatus ? false : !!state.overlayHidden
  }
  // Room media follows the auction: START closes the welcome screen; PAUSE starts the music,
  // leaving PAUSED (resume, sold, passed in, end) stops it. The buttons can still override.
  if (cmd.type === 'START') next.welcomeOn = false
  if (cmd.type !== 'SET_MUSIC') {
    if (next.sessionStatus === 'PAUSED' && state.sessionStatus !== 'PAUSED') next.musicOn = true
    else if (state.sessionStatus === 'PAUSED' && next.sessionStatus !== 'PAUSED') next.musicOn = false
    else if (next.sessionStatus === 'ENDED' && state.sessionStatus !== 'ENDED') next.musicOn = false
  }
  next.stateVersion = state.stateVersion + 1
  next.eventSeq = state.eventSeq + 1
  next.updatedAt = ctx.now

  const event: AuctionEvent = {
    sessionId: state.sessionId,
    seq: next.eventSeq,
    type,
    previousState: snapshot(prev),
    newState: snapshot(next),
    operatorId: ctx.operatorId,
    serverTimestamp: ctx.now,
    stateVersion: next.stateVersion,
    reason,
    idempotencyKey: ctx.idempotencyKey,
    data,
  }
  return { state: next, bids: nextBids, events: [event], bid: newBid }
}
