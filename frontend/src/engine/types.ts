export type SessionStatus = 'NOT_STARTED' | 'LIVE' | 'PAUSED' | 'ENDED'
export type SaleStatus = 'NONE' | 'ON_THE_MARKET' | 'SOLD' | 'PASSED_IN'

/** Server-derived status shown to the room. */
export type PublicStatus = 'NOT_STARTED' | 'LIVE' | 'PAUSED' | 'ON_THE_MARKET' | 'SOLD' | 'PASSED_IN' | 'ENDED'

/** Client-local overlays on the display — never stored on the server. */
export type DisplayOverlay = 'NONE' | 'RECONNECTING' | 'CONNECTION_LOST'

export type Role = 'operator' | 'admin'

export interface User {
  id: string
  name: string
  role: Role
  email?: string
  active?: boolean
}

export interface Property {
  addressLine: string
  suburb: string
  city: string
  /** Stored image reference (idb-image:…), URL or data: URI */
  heroImage: string | null
  bedrooms: number | null
  bathrooms: number | null
  /** Garage / car parks */
  parking: number | null
  landAreaM2: number | null
  floorAreaM2: number | null
  /** Optional corner badge on the room display, e.g. "Brought Forward" */
  badge: string
}

export interface Salesperson {
  name: string
  /** Stored image reference, URL or data URI */
  photo: string | null
}

export const MAX_SALESPEOPLE = 2

export interface Session {
  id: string
  title: string
  scheduledAt: string
  /** Internal record only — not shown on the room display */
  auctioneerName: string
  /** Listing salespeople shown on the room display (0–2) */
  salespeople: Salesperson[]
  defaultIncrementCents: string
  /** PRIVATE — never sent to a display */
  reserveCents: string | null
  /** PRIVATE — never sent to a display */
  internalNotes: string
  property: Property
  createdAt: string
  createdBy: string
}

export type BidStatus = 'ACTIVE' | 'REVERSED' | 'CORRECTED'

export interface Bid {
  id: string
  sessionId: string
  seq: number
  amountCents: string
  status: BidStatus
  supersedesBidId: string | null
  operatorId: string
  idempotencyKey: string
  source: 'CLOUD' | 'OFFLINE_IMPORT'
  createdAt: string
}

export interface AuctionState {
  sessionId: string
  sessionStatus: SessionStatus
  saleStatus: SaleStatus
  currentBidId: string | null
  currentBidCents: string | null
  bidCount: number
  stateVersion: number
  eventSeq: number
  updatedAt: string
  /** Operator hid the stickers (status circle + badge) on the room display. Missing = false. */
  overlayHidden?: boolean
  /** Room screen: full-screen welcome image + welcome music. Closed automatically by START. */
  welcomeOn?: boolean
  /** Room screen music (the "pause" music). Starts automatically on PAUSE, stops on RESUME / end. */
  musicOn?: boolean
  /** Room screen music volume 0–100 (missing = 80). */
  volume?: number
  /** Where the auction was just before Sold / Passed in / End — restored by REOPEN. */
  concludedFrom?: { sessionStatus: SessionStatus; saleStatus: SaleStatus } | null
}

/** Compact state captured in audit events. */
export type StateSnapshot = Pick<
  AuctionState,
  'sessionStatus' | 'saleStatus' | 'currentBidId' | 'currentBidCents' | 'bidCount' | 'stateVersion'
>

export type EventType =
  | 'AUCTION_STARTED'
  | 'BID_ACCEPTED'
  | 'BID_CORRECTED'
  | 'BID_UNDONE'
  | 'PAUSED'
  | 'RESUMED'
  | 'ON_THE_MARKET'
  | 'OFF_THE_MARKET'
  | 'REOPENED'
  | 'WELCOME_SHOWN'
  | 'WELCOME_HIDDEN'
  | 'MUSIC_STARTED'
  | 'MUSIC_STOPPED'
  | 'VOLUME_SET'
  | 'OVERLAY_HIDDEN'
  | 'OVERLAY_SHOWN'
  | 'SOLD'
  | 'PASSED_IN'
  | 'AUCTION_ENDED'
  | 'OPERATOR_ACQUIRED'
  | 'OPERATOR_RELEASED'
  | 'OPERATOR_TAKEOVER'
  | 'DISPLAY_PAIRED'
  | 'DISPLAY_REVOKED'
  | 'DISPLAY_MOVED_IN'
  | 'DISPLAY_MOVED_OUT'

export interface AuctionEvent {
  sessionId: string
  seq: number
  type: EventType
  previousState: StateSnapshot
  newState: StateSnapshot
  operatorId: string | null
  serverTimestamp: string
  stateVersion: number
  reason: string | null
  idempotencyKey: string | null
  data: Record<string, string | number | null> | null
}

export type Command =
  | { type: 'START' }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'END' }
  | { type: 'OFF_MARKET' }
  | { type: 'REOPEN'; reason: string }
  | { type: 'SET_WELCOME'; on: boolean }
  | { type: 'SET_MUSIC'; on: boolean }
  | { type: 'SET_VOLUME'; percent: number }
  | { type: 'SET_OVERLAY'; hidden: boolean }
  | { type: 'ON_THE_MARKET' }
  | { type: 'SOLD' }
  | { type: 'PASSED_IN' }
  | { type: 'BID'; amountCents: string }
  | { type: 'UNDO'; bidId: string; reason: string }
  | { type: 'CORRECT'; bidId: string; amountCents: string; reason: string }

export interface OperatorLease {
  sessionId: string
  userId: string
  userName: string
  leaseToken: string
  acquiredAt: string
  renewedAt: string
  expiresAt: string
  releasedAt: string | null
}

export interface Device {
  id: string
  sessionId: string
  label: string
  tokenHash: string
  approvedBy: string
  approvedAt: string
  revokedAt: string | null
  lastHeartbeatAt: string | null
  lastAckedVersion: number
  lastAckedAt: string | null
  /** What the screen's speakers are doing, reported by the display */
  audioStatus?: AudioStatus | null
}

export type AudioStatus = 'off' | 'loading' | 'playing' | 'blocked' | 'error'

export interface Pairing {
  id: string
  code: string
  createdAt: string
  expiresAt: string
  status: 'PENDING' | 'APPROVED' | 'EXPIRED' | 'CLAIMED'
  sessionId: string | null
  deviceId: string | null
  /** Plain token held only until the display claims it once. */
  pendingToken: string | null
}

/** A paired screen as listed for staff (any session) — never includes the token hash. */
export type DeviceSummary = Omit<Device, 'tokenHash'> & { sessionTitle: string; sessionAddress: string }

/** Company-wide room screen media, the same for every session (set on the Room media page). */
export interface RoomMedia {
  welcomeImage: string | null
  welcomeMusic: string | null
  pauseMusic: string | null
}

export const DEFAULT_VOLUME = 80

/** The ONLY shape a room display ever receives. */
export interface PublicDisplayState {
  sessionId: string
  stateVersion: number
  sessionStatus: SessionStatus
  saleStatus: SaleStatus
  publicStatus: PublicStatus
  /** true → the display shows no status circle and no badge sticker. */
  overlayHidden: boolean
  welcomeOn: boolean
  musicOn: boolean
  /** 0–100 */
  volume: number
  /** Company-wide room media (null welcomeImage → built-in image; null pauseMusic → welcome music) */
  media: RoomMedia
  currentBidCents: string | null
  currentBidDisplay: string
  property: {
    addressLine: string
    suburb: string
    city: string
    heroImage: string | null
    bedrooms: number | null
    bathrooms: number | null
    parking: number | null
    landAreaM2: number | null
    floorAreaM2: number | null
    badge: string
  }
  salespeople: Salesperson[]
  brand: { name: string }
  serverTime: string
}

export type ErrorCode =
  | 'INVALID_AMOUNT'
  | 'VALIDATION_FAILED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'BID_NOT_HIGHER'
  | 'INVALID_TRANSITION'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'REQUEST_IN_PROGRESS'
  | 'LEASE_REQUIRED'
  | 'LEASE_EXPIRED'
  | 'LEASE_HELD_BY_OTHER'
  | 'UNAUTHENTICATED'
  | 'NETWORK_ERROR'
  | 'RESPONSE_LOST'
  | 'STORAGE_FULL'

export class ApiError extends Error {
  code: ErrorCode
  status: number
  details?: Record<string, unknown>
  constructor(code: ErrorCode, message: string, status = 400, details?: Record<string, unknown>) {
    super(message)
    this.code = code
    this.status = status
    this.details = details
  }
}
