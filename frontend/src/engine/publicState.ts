/**
 * Public display serializer — EXPLICIT WHITELIST.
 * Every field the room display receives is listed here by hand. Nothing is
 * spread from the source objects, so new private fields can never leak by accident.
 */
import { formatCents } from '../lib/money'
import { DEFAULT_VOLUME, MAX_SALESPEOPLE, type AuctionState, type RoomMedia, type PublicDisplayState, type PublicStatus, type Session } from './types'

export const BRAND_NAME = 'Harcourts Golden Links'

export function derivePublicStatus(s: Pick<AuctionState, 'sessionStatus' | 'saleStatus'>): PublicStatus {
  if (s.saleStatus === 'SOLD') return 'SOLD'
  if (s.saleStatus === 'PASSED_IN') return 'PASSED_IN'
  switch (s.sessionStatus) {
    case 'NOT_STARTED':
      return 'NOT_STARTED'
    case 'PAUSED':
      return 'PAUSED'
    case 'ENDED':
      return 'ENDED'
    case 'LIVE':
      return s.saleStatus === 'ON_THE_MARKET' ? 'ON_THE_MARKET' : 'LIVE'
  }
}

export function toPublicState(session: Session, state: AuctionState, serverTime: string, media?: RoomMedia | null): PublicDisplayState {
  return {
    sessionId: state.sessionId,
    stateVersion: state.stateVersion,
    sessionStatus: state.sessionStatus,
    saleStatus: state.saleStatus,
    publicStatus: derivePublicStatus(state),
    overlayHidden: !!state.overlayHidden,
    welcomeOn: !!state.welcomeOn,
    musicOn: !!state.musicOn,
    volume: state.volume ?? DEFAULT_VOLUME,
    media: { welcomeImage: media?.welcomeImage ?? null, welcomeMusic: media?.welcomeMusic ?? null, pauseMusic: media?.pauseMusic ?? null },
    currentBidCents: state.currentBidCents,
    currentBidDisplay: state.currentBidCents ? formatCents(state.currentBidCents) : '',
    property: {
      addressLine: session.property.addressLine,
      suburb: session.property.suburb,
      city: session.property.city,
      heroImage: session.property.heroImage,
      bedrooms: session.property.bedrooms ?? null,
      bathrooms: session.property.bathrooms ?? null,
      parking: session.property.parking ?? null,
      landAreaM2: session.property.landAreaM2 ?? null,
      floorAreaM2: session.property.floorAreaM2 ?? null,
      badge: session.property.badge ?? '',
    },
    salespeople: (session.salespeople ?? [])
      .filter((p) => p.name?.trim())
      .slice(0, MAX_SALESPEOPLE)
      .map((p) => ({ name: p.name.trim(), photo: p.photo ?? null })),
    brand: { name: BRAND_NAME },
    serverTime,
  }
}

/** Keys that must never appear anywhere in a public payload (checked in tests). */
export const FORBIDDEN_PUBLIC_KEYS = [
  'reserveCents',
  'reserve',
  'internalNotes',
  'notes',
  'reason',
  'operatorId',
  'operator',
  'idempotencyKey',
  'bids',
  'events',
  'leaseToken',
  'tokenHash',
  'createdBy',
  'auctioneerName',
] as const
