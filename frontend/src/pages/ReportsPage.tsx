import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useSessions } from '../app/hooks'
import { server } from '../app/server'
import type { AuctionEvent, Bid } from '../engine/types'
import { formatCents } from '../lib/money'
import { downloadFile } from '../lib/offlineStore'

let names = new Map<string, string>()
const userName = (id: string | null) => (id ? (names.get(id) ?? id) : '—')
const ts = (iso: string) => new Date(iso).toLocaleString('en-NZ', { hour12: false })

function describe(e: AuctionEvent): string {
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
    default:
      return e.type.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())
  }
}

function toCsv(events: AuctionEvent[]): string {
  const head = ['seq', 'server_timestamp', 'type', 'state_version', 'operator', 'reason', 'prev_session', 'new_session', 'prev_sale', 'new_sale', 'prev_bid_cents', 'new_bid_cents', 'description']
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const rows = events.map((e) =>
    [
      e.seq,
      e.serverTimestamp,
      e.type,
      e.stateVersion,
      userName(e.operatorId),
      e.reason,
      e.previousState.sessionStatus,
      e.newState.sessionStatus,
      e.previousState.saleStatus,
      e.newState.saleStatus,
      e.previousState.currentBidCents,
      e.newState.currentBidCents,
      describe(e),
    ]
      .map(esc)
      .join(','),
  )
  return [head.join(','), ...rows].join('\n')
}

export function ReportsPage() {
  const sessions = useSessions()
  const [sid, setSid] = useState<string | null>(null)
  useEffect(() => {
    if (!sid && sessions.data?.length) setSid(sessions.data[0].session.id)
  }, [sessions.data, sid])
  const users = useQuery({ queryKey: ['user-names'], queryFn: () => server.auth.listUsers(), staleTime: 60_000 })
  names = new Map((users.data ?? []).map((u) => [u.id, u.name]))
  const events = useQuery({ queryKey: ['events', sid], queryFn: () => server.staff.getEvents(sid!), enabled: !!sid, refetchInterval: 2000 })
  const bids = useQuery({ queryKey: ['bids', sid], queryFn: () => server.staff.getBids(sid!), enabled: !!sid, refetchInterval: 2000 })
  const session = sessions.data?.find((s) => s.session.id === sid)

  return (
    <div className="mx-auto max-w-6xl p-6 print:max-w-none print:p-0">
      <div className="mb-5 flex items-center gap-4 print:hidden">
        <h1 className="text-2xl font-bold text-navy">Scribe record &amp; audit trail</h1>
        <select className="ml-auto rounded-md border border-line bg-surface-2 px-3 py-1.5 font-semibold text-navy" value={sid ?? ''} onChange={(e) => setSid(e.target.value)}>
          {sessions.data?.map(({ session: s }) => (
            <option key={s.id} value={s.id}>
              {s.property.addressLine}, {s.property.suburb}
            </option>
          ))}
        </select>
        <button className="btn-ghost text-sm" disabled={!events.data} onClick={() => downloadFile(`audit-${sid}.csv`, toCsv(events.data!), 'text/csv')}>
          Export CSV
        </button>
        <button
          className="btn-ghost text-sm"
          disabled={!events.data}
          onClick={() => downloadFile(`audit-${sid}.json`, JSON.stringify({ session: session?.session, bids: bids.data, events: events.data }, null, 2))}
        >
          Export JSON
        </button>
        <button className="btn-ghost text-sm" onClick={() => window.print()}>
          Print
        </button>
      </div>

      {session && (
        <div className="panel mb-4 grid grid-cols-4 gap-4 p-4 text-sm">
          <Stat label="Property" value={`${session.session.property.addressLine}, ${session.session.property.suburb}`} />
          <Stat label="Outcome" value={session.state.saleStatus === 'NONE' ? session.state.sessionStatus.replace('_', ' ') : session.state.saleStatus.replace('_', ' ')} />
          <Stat label="Final / current bid" value={formatCents(session.state.currentBidCents)} />
          <Stat label="Accepted bids · events" value={`${session.state.bidCount} · ${events.data?.length ?? 0}`} />
        </div>
      )}

      <h2 className="panel-title mb-2">Bids (append-only)</h2>
      <div className="panel mb-6 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-subtle text-left text-[10px] uppercase tracking-widest text-ink-faint">
            <tr>
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">Server time</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Operator</th>
              <th className="px-3 py-2">Source</th>
            </tr>
          </thead>
          <tbody>
            {(bids.data ?? []).map((b: Bid) => (
              <tr key={b.id} className="border-t border-line">
                <td className="px-3 py-1.5 text-ink-faint">{b.seq}</td>
                <td className="px-3 py-1.5">{ts(b.createdAt)}</td>
                <td className={`px-3 py-1.5 text-right font-bold ${b.status === 'ACTIVE' ? 'text-navy' : 'text-ink-faint line-through'}`}>{formatCents(b.amountCents)}</td>
                <td className="px-3 py-1.5">{b.status}{b.supersedesBidId ? ' (correction)' : ''}</td>
                <td className="px-3 py-1.5">{userName(b.operatorId)}</td>
                <td className="px-3 py-1.5 text-ink-muted">{b.source}</td>
              </tr>
            ))}
            {!bids.data?.length && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-ink-muted">
                  No bids.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2 className="panel-title mb-2">Audit events (immutable)</h2>
      <div className="panel overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-subtle text-left text-[10px] uppercase tracking-widest text-ink-faint">
            <tr>
              <th className="px-3 py-2">Seq</th>
              <th className="px-3 py-2">Server time</th>
              <th className="px-3 py-2">Event</th>
              <th className="px-3 py-2">Ver</th>
              <th className="px-3 py-2">State change</th>
              <th className="px-3 py-2">Operator</th>
              <th className="px-3 py-2">Reason</th>
            </tr>
          </thead>
          <tbody>
            {(events.data ?? []).map((e) => (
              <tr key={e.seq} className="border-t border-line align-top">
                <td className="px-3 py-1.5 text-ink-faint">{e.seq}</td>
                <td className="whitespace-nowrap px-3 py-1.5">{ts(e.serverTimestamp)}</td>
                <td className="px-3 py-1.5 font-semibold text-navy">{describe(e)}</td>
                <td className="px-3 py-1.5 text-ink-muted">v{e.stateVersion}</td>
                <td className="px-3 py-1.5 text-xs text-ink-muted">
                  {e.previousState.sessionStatus !== e.newState.sessionStatus && (
                    <div>
                      {e.previousState.sessionStatus} → {e.newState.sessionStatus}
                    </div>
                  )}
                  {e.previousState.saleStatus !== e.newState.saleStatus && (
                    <div>
                      {e.previousState.saleStatus} → {e.newState.saleStatus}
                    </div>
                  )}
                  {e.previousState.currentBidCents !== e.newState.currentBidCents && (
                    <div>
                      {formatCents(e.previousState.currentBidCents)} → {formatCents(e.newState.currentBidCents)}
                    </div>
                  )}
                </td>
                <td className="px-3 py-1.5">{userName(e.operatorId)}</td>
                <td className="px-3 py-1.5 text-warn">{e.reason ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="panel-title">{label}</div>
      <div className="mt-1 font-bold text-navy">{value}</div>
    </div>
  )
}
