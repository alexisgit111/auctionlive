/**
 * Auction report as a real PDF (A4), generated in the browser.
 * Loaded on demand (dynamic import) so jsPDF never weighs on the console or the room display.
 */
import { jsPDF } from 'jspdf'
import { autoTable } from 'jspdf-autotable'
import logoUrl from '../assets/brand/logo.svg'
import type { AuctionEvent, AuctionState, Bid, Session } from '../engine/types'
import { describeEvent } from './auditText'
import { sha256 } from './ids'
import { resolveImage } from './imageStore'
import { formatCents } from './money'

export interface ReportInput {
  session: Session
  state: AuctionState
  bids: Bid[]
  events: AuctionEvent[]
  userName: (id: string | null) => string
  generatedBy: string
}

const NAVY: [number, number, number] = [0, 29, 74]
const BLUE: [number, number, number] = [0, 161, 233]
const MUTED: [number, number, number] = [96, 108, 128]
const LINE: [number, number, number] = [221, 227, 236]
const OK: [number, number, number] = [22, 128, 72]
const TZ = 'Pacific/Auckland'

const dt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-NZ', { timeZone: TZ, hour12: false, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'
const tm = (iso: string) => new Date(iso).toLocaleTimeString('en-NZ', { timeZone: TZ, hour12: false })
const day = (iso: string) => new Date(iso).toLocaleDateString('en-NZ', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

function duration(a: string | null, b: string | null) {
  if (!a || !b) return '—'
  const s = Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000))
  const m = Math.floor(s / 60)
  return m ? `${m} min ${s % 60} s` : `${s} s`
}

/** Rasterise an image URL (SVG or photo) to a data URL jsPDF can embed. */
async function rasterise(url: string, maxW: number, type: 'image/png' | 'image/jpeg'): Promise<{ data: string; w: number; h: number } | null> {
  try {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = url
    await img.decode()
    const ratio = img.naturalHeight / img.naturalWidth || 0.14
    const w = Math.min(maxW, img.naturalWidth || maxW)
    const c = document.createElement('canvas')
    c.width = w
    c.height = Math.round(w * ratio)
    const ctx = c.getContext('2d')!
    if (type === 'image/jpeg') {
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, c.width, c.height)
    }
    ctx.drawImage(img, 0, 0, c.width, c.height)
    return { data: c.toDataURL(type, 0.85), w: c.width, h: c.height }
  } catch {
    return null
  }
}

export function outcomeOf(state: AuctionState): { label: string; amountLabel: string; tone: 'ok' | 'navy' } {
  if (state.saleStatus === 'SOLD') return { label: 'SOLD', amountLabel: 'Sold for', tone: 'ok' }
  if (state.saleStatus === 'PASSED_IN') return { label: 'PASSED IN', amountLabel: 'Highest bid', tone: 'navy' }
  if (state.sessionStatus === 'ENDED') return { label: 'ENDED — NO RESULT', amountLabel: 'Highest bid', tone: 'navy' }
  if (state.sessionStatus === 'NOT_STARTED') return { label: 'NOT STARTED', amountLabel: 'Current bid', tone: 'navy' }
  return { label: 'IN PROGRESS (interim report)', amountLabel: 'Current bid', tone: 'navy' }
}

export async function buildAuctionReportPdf(r: ReportInput): Promise<{ blob: Blob; filename: string }> {
  const { session, state } = r
  const p = session.property
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const M = 16
  const generatedAt = new Date().toISOString()

  const events = [...r.events].sort((a, b) => a.seq - b.seq)
  const bids = [...r.bids].sort((a, b) => a.seq - b.seq)
  const started = events.find((e) => e.type === 'AUCTION_STARTED')?.serverTimestamp ?? null
  const ended = events.find((e) => e.newState.sessionStatus === 'ENDED' && e.previousState.sessionStatus !== 'ENDED')?.serverTimestamp ?? null
  const active = bids.filter((b) => b.status === 'ACTIVE')
  const operators = [...new Set(bids.map((b) => r.userName(b.operatorId)))].join(', ') || '—'
  const fingerprint = await sha256(JSON.stringify(events))

  // ── header ──
  const logo = await rasterise(logoUrl, 1200, 'image/png')
  if (logo) doc.addImage(logo.data, 'PNG', M, M, 62, (62 * logo.h) / logo.w)
  doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(...BLUE)
  doc.text('AUCTION REPORT', W - M, M + 3, { align: 'right', charSpace: 0.6 })
  doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...MUTED)
  doc.text(`Generated ${dt(generatedAt)}`, W - M, M + 8, { align: 'right' })
  doc.text(`by ${r.generatedBy}`, W - M, M + 12, { align: 'right' })
  doc.setDrawColor(...NAVY).setLineWidth(0.6).line(M, M + 16, W - M, M + 16)

  // ── property ──
  let y = M + 26
  const photoW = 58
  const photoH = 38
  const photoUrl = p.heroImage ? await resolveImage(p.heroImage) : null
  const photo = photoUrl ? await rasterise(photoUrl, 900, 'image/jpeg') : null
  const textW = W - 2 * M - (photo ? photoW + 6 : 0)
  if (photo) {
    // cover-crop into the frame
    const frameRatio = photoH / photoW
    const imgRatio = photo.h / photo.w
    let dw = photoW
    let dh = photoW * imgRatio
    if (imgRatio < frameRatio) {
      dh = photoH
      dw = photoH / imgRatio
    }
    const x0 = W - M - photoW
    doc.saveGraphicsState()
    doc.rect(x0, y - 6, photoW, photoH).clip().discardPath()
    doc.addImage(photo.data, 'JPEG', x0 - (dw - photoW) / 2, y - 6 - (dh - photoH) / 2, dw, dh)
    doc.restoreGraphicsState()
  }
  doc.setFont('helvetica', 'bold').setFontSize(18).setTextColor(...NAVY)
  const addr = doc.splitTextToSize(p.addressLine || session.title, textW) as string[]
  doc.text(addr, M, y)
  y += addr.length * 7
  doc.setFont('helvetica', 'normal').setFontSize(11).setTextColor(...BLUE)
  doc.text([p.suburb, p.city].filter(Boolean).join(', ') || ' ', M, y)
  y += 6
  doc.setFontSize(9).setTextColor(...MUTED)
  const sub = [session.title && session.title.trim() !== p.addressLine.trim() ? session.title : '', session.scheduledAt ? day(session.scheduledAt) : '']
    .filter(Boolean)
    .join(' · ')
  doc.text(doc.splitTextToSize(sub || ' ', textW) as string[], M, y)
  y = Math.max(y + 8, photo ? M + 26 - 6 + photoH + 6 : 0)

  // ── outcome band ──
  const o = outcomeOf(state)
  doc.setFillColor(244, 247, 251).setDrawColor(...LINE).setLineWidth(0.2)
  doc.roundedRect(M, y, W - 2 * M, 24, 2, 2, 'FD')
  doc.setFont('helvetica', 'bold').setFontSize(8).setTextColor(...MUTED)
  doc.text('RESULT', M + 6, y + 8, { charSpace: 0.5 })
  doc.setFontSize(17).setTextColor(...(o.tone === 'ok' ? OK : NAVY))
  doc.text(o.label, M + 6, y + 17)
  doc.setFontSize(8).setTextColor(...MUTED)
  doc.text(o.amountLabel.toUpperCase(), W - M - 6, y + 8, { align: 'right', charSpace: 0.5 })
  doc.setFontSize(20).setTextColor(...NAVY)
  doc.text(state.currentBidCents ? formatCents(state.currentBidCents) : '—', W - M - 6, y + 18, { align: 'right' })
  y += 32

  // ── facts ──
  const salespeople = (session.salespeople ?? []).map((s) => s.name).filter(Boolean).join(', ') || '—'
  const facts: [string, string][] = [
    ['Auction started', dt(started)],
    ['Auction ended', dt(ended)],
    ['Duration', duration(started, ended)],
    ['Accepted bids', String(active.length)],
    ['Opening bid', active[0] ? formatCents(active[0].amountCents) : '—'],
    ['Reserve (internal)', session.reserveCents ? formatCents(session.reserveCents) : '—'],
    ['Auctioneer', session.auctioneerName || '—'],
    ['Salespeople', salespeople],
    ['Bids entered by', operators],
  ]
  const colW = (W - 2 * M) / 3
  facts.forEach(([k, v], i) => {
    const cx = M + (i % 3) * colW
    const cy = y + Math.floor(i / 3) * 13
    doc.setFont('helvetica', 'bold').setFontSize(7).setTextColor(...MUTED)
    doc.text(k.toUpperCase(), cx, cy, { charSpace: 0.4 })
    doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(...NAVY)
    doc.text((doc.splitTextToSize(v, colW - 4) as string[])[0], cx, cy + 5)
  })
  y += Math.ceil(facts.length / 3) * 13 + 4

  // ── bids ──
  const sectionTitle = (t: string, at: number) => {
    doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...NAVY)
    doc.text(t, M, at)
  }
  sectionTitle('Bid record', y)
  let prevActive: bigint | null = null
  const bidRows = bids.map((b) => {
    let inc = ''
    if (b.status === 'ACTIVE') {
      const a = BigInt(b.amountCents)
      inc = prevActive === null ? 'Opening' : `+${formatCents((a - prevActive).toString())}`
      prevActive = a
    }
    const status = b.status === 'ACTIVE' ? (b.supersedesBidId ? 'Accepted (correction)' : 'Accepted') : b.status === 'REVERSED' ? 'Undone' : 'Corrected'
    return [String(b.seq), tm(b.createdAt), formatCents(b.amountCents), inc, status, r.userName(b.operatorId)]
  })
  const tableStyle = {
    theme: 'plain' as const,
    margin: { left: M, right: M, top: M + 8, bottom: 18 },
    styles: { font: 'helvetica', fontSize: 8.5, textColor: NAVY, cellPadding: { top: 1.6, bottom: 1.6, left: 2, right: 2 }, lineColor: LINE },
    headStyles: { fontStyle: 'bold' as const, fontSize: 7, textColor: MUTED, fillColor: [244, 247, 251] as [number, number, number] },
    bodyStyles: { lineWidth: { bottom: 0.15 } },
  }
  autoTable(doc, {
    ...tableStyle,
    startY: y + 3,
    head: [['#', 'TIME', 'AMOUNT', 'INCREASE', 'STATUS', 'ENTERED BY']],
    body: bidRows.length ? bidRows : [['', '', 'No bids recorded', '', '', '']],
    columnStyles: { 0: { cellWidth: 10, textColor: MUTED }, 1: { cellWidth: 22 }, 2: { halign: 'right', fontStyle: 'bold', cellWidth: 32 }, 3: { halign: 'right', textColor: MUTED, cellWidth: 28 } },
    didParseCell: (d) => {
      if (d.section === 'body' && bids[d.row.index] && bids[d.row.index].status !== 'ACTIVE') d.cell.styles.textColor = [160, 168, 182]
    },
  })

  // ── audit trail ──
  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10
  if (y > H - 40) {
    doc.addPage()
    y = M + 8
  }
  sectionTitle('Audit trail', y)
  autoTable(doc, {
    ...tableStyle,
    startY: y + 3,
    head: [['SEQ', 'TIME', 'EVENT', 'BY', 'REASON']],
    body: events.map((e) => [String(e.seq), tm(e.serverTimestamp), describeEvent(e), r.userName(e.operatorId), e.reason ?? '']),
    columnStyles: { 0: { cellWidth: 11, textColor: MUTED }, 1: { cellWidth: 22 }, 3: { cellWidth: 34 }, 4: { cellWidth: 40, textColor: [180, 110, 0] } },
  })

  // ── sign-off ──
  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8
  if (y > H - 46) {
    doc.addPage()
    y = M + 16
  }
  doc.setDrawColor(...MUTED).setLineWidth(0.2)
  const sw = (W - 2 * M - 12) / 2
  ;['Auctioneer', 'Scribe / operator'].forEach((who, i) => {
    const x = M + i * (sw + 12)
    doc.line(x, y + 12, x + sw, y + 12)
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...MUTED)
    doc.text(`${who} — signature & date`, x, y + 16)
  })
  y += 26
  doc.setFontSize(7).setTextColor(...MUTED)
  doc.text(`Record fingerprint (SHA-256 of ${events.length} audit events): ${fingerprint}`, M, y)
  doc.text(`Session ID ${session.id} · state version ${state.stateVersion}`, M, y + 4)

  // ── footers ──
  const pages = doc.getNumberOfPages()
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i)
    doc.setDrawColor(...LINE).setLineWidth(0.2).line(M, H - 12, W - M, H - 12)
    doc.setFont('helvetica', 'normal').setFontSize(7).setTextColor(...MUTED)
    doc.text('Harcourts Golden Links · Auction Live — internal scribe record · goldenlinks.co.nz', M, H - 8)
    doc.text(`Page ${i} of ${pages}`, W - M, H - 8, { align: 'right' })
  }

  doc.setProperties({ title: `Auction report — ${p.addressLine}`, author: 'Harcourts Golden Links', creator: 'Golden Links Auction Live' })
  const date = new Date(started ?? generatedAt).toLocaleDateString('en-CA', { timeZone: TZ })
  const safe = (p.addressLine || session.title).replace(/[^\w\s-]/g, '').replace(/\s+/g, ' ').trim()
  return { blob: doc.output('blob'), filename: `Auction report - ${safe} - ${date}.pdf` }
}
