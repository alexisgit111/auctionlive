/** Human-readable audit event text — shared by the Reports page, CSV and PDF. */
import type { AuctionEvent } from '../engine/types'
import { formatCents } from './money'

export function describeEvent(e: AuctionEvent): string {
  const d = e.data ?? {}
  switch (e.type) {
    case 'BID_ACCEPTED':
      return `Bid #${d.bidSeq} accepted: ${formatCents(String(d.amountCents))}`
    case 'BID_UNDONE':
      return `Bid ${formatCents(String(d.amountCents))} undone`
    case 'BID_CORRECTED':
      return `Bid corrected ${formatCents(String(d.fromCents))} → ${formatCents(String(d.toCents))}`
    case 'SOLD':
      return `SOLD at ${formatCents(String(d.soldCents))}`
    case 'PASSED_IN':
      return `Passed in${d.highestCents ? ` at ${formatCents(String(d.highestCents))}` : ''}`
    case 'OPERATOR_TAKEOVER':
      return `Control taken over from ${d.fromUserName ?? 'nobody'}`
    case 'DISPLAY_PAIRED':
      return `Display paired: ${d.label}`
    case 'DISPLAY_REVOKED':
      return `Display revoked: ${d.label}`
    case 'DISPLAY_MOVED_IN':
      return `Display moved here: ${d.label}`
    case 'DISPLAY_MOVED_OUT':
      return `Display moved to another session: ${d.label}`
    case 'OFF_THE_MARKET':
      return 'Taken off the market (undo)'
    case 'OVERLAY_HIDDEN':
      return 'Room display stickers hidden'
    case 'OVERLAY_SHOWN':
      return 'Room display stickers shown'
    default:
      return e.type.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())
  }
}

