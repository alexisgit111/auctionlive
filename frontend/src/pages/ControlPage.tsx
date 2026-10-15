import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useCloudHealth, useCommandRunner, useFaults, useNow, useOperatorLease, useSessions, useStaffView } from '../app/hooks'
import { server } from '../app/server'
import { useUser } from '../app/user'
import { BidEntry } from '../components/console/BidEntry'
import {
  AuctionControls,
  BidHistory,
  CurrentBidCard,
  DisplayPanel,
  FaultPanel,
  HealthStrip,
  LeasePanel,
  OfflinePanel,
} from '../components/console/panels'
import { ErrorNote, Modal } from '../components/ui'
import { allowedCommands } from '../engine/engine'
import { anyFaultActive } from '../engine/faults'
import type { Command } from '../engine/types'
import type { Cents } from '../lib/money'
import { setWorkerInterval } from '../lib/workerTimer'
import { addOfflineRecord, listOfflineRecords, type OfflineRecord } from '../lib/offlineStore'

const SESSION_KEY = 'gl-auction-console-session'

export function ControlPage() {
  const { user } = useUser()
  const [params, setParams] = useSearchParams()
  const sessions = useSessions()
  const [sessionId, setSessionId] = useState<string | null>(() => params.get('session') ?? sessionStorage.getItem(SESSION_KEY))

  // Default to the most recent session.
  useEffect(() => {
    const list = sessions.data
    if (!list?.length) return
    if (!sessionId || !list.some((s) => s.session.id === sessionId)) setSessionId(list[0].session.id)
  }, [sessions.data, sessionId])
  useEffect(() => {
    if (!sessionId) return
    sessionStorage.setItem(SESSION_KEY, sessionId)
    if (params.get('session') !== sessionId) setParams({ session: sessionId }, { replace: true })
  }, [sessionId, params, setParams])

  useEffect(() => {
    void server.ensureSeed()
    // This console tab also runs the outbox relay sweep (Phase 1B: Supervisor worker).
    return setWorkerInterval(() => void server.staff.relayOutbox(), 1000)
  }, [])

  const now = useNow(500)
  const cloud = useCloudHealth()
  const faults = useFaults()
  const viewQ = useStaffView(sessionId)
  const view = viewQ.data
  const lease = useOperatorLease(sessionId, user, view?.lease)
  const runner = useCommandRunner(sessionId, user, lease.token)
  const [dialog, setDialog] = useState<null | 'SOLD' | 'PASSED_IN' | 'END' | 'UNDO' | 'CORRECT'>(null)

  // Offline provisional records
  const [offlineRecs, setOfflineRecs] = useState<OfflineRecord[]>([])
  const refreshOffline = useCallback(async () => {
    if (!sessionId) return
    try {
      setOfflineRecs(await listOfflineRecords(sessionId))
    } catch {
      /* IndexedDB unavailable */
    }
  }, [sessionId])
  useEffect(() => void refreshOffline(), [refreshOffline])

  const cloudOk = cloud.status !== 'OFFLINE'
  const offline = cloud.status === 'OFFLINE'

  const run = async (cmd: Command): Promise<boolean> => {
    if (!view) return false
    const r = await runner.run(cmd, view.state.stateVersion)
    return !!r
  }

  const submitBid = async (cents: Cents): Promise<boolean> => {
    if (!view || !sessionId) return false
    if (offline) {
      await addOfflineRecord({
        sessionId,
        type: 'BID',
        amountCents: cents.toString(),
        note: '',
        operatorId: user.id,
        operatorName: user.name,
      })
      await refreshOffline()
      return true
    }
    return run({ type: 'BID', amountCents: cents.toString() })
  }

  const allowed = view ? allowedCommands(view.state) : new Set()
  const bidDisabledReason = !view
    ? 'Loading…'
    : offline && lease.hasControl
      ? null
      : !lease.hasControl
        ? 'Take operator control to enter bids'
        : cloud.status === 'DEGRADED'
          ? 'Checking cloud connection…'
          : !allowed.has('BID')
            ? view.state.sessionStatus === 'NOT_STARTED'
              ? 'Start the auction to enter bids'
              : view.state.sessionStatus === 'PAUSED'
                ? 'Auction paused — resume to enter bids'
                : 'Auction has concluded'
            : null
  // Offline scribing allowed only when we held control and the auction was live.
  const canBid = !!view && lease.hasControl && (offline ? view.state.sessionStatus === 'LIVE' : bidDisabledReason === null)

  const controlsEnabled = !!view && lease.hasControl && cloud.status === 'ONLINE'

  if (sessions.isError && !sessions.data) {
    return (
      <div className="p-8">
        <ErrorNote>Cannot reach Auction Live cloud. {String(sessions.error)}</ErrorNote>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* Session bar + health */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-3">
          <label htmlFor="session" className="text-sm font-bold uppercase tracking-[0.12em] text-ink-muted">
            Session
          </label>
          <select
            id="session"
            className="rounded-lg border border-line bg-surface-2 px-4 py-2.5 text-lg font-semibold text-navy"
            value={sessionId ?? ''}
            onChange={(e) => setSessionId(e.target.value)}
          >
            {sessions.data?.map(({ session, state }) => (
              <option key={session.id} value={session.id}>
                {session.property.addressLine}, {session.property.suburb} — {state.sessionStatus.replace('_', ' ')}
              </option>
            ))}
          </select>
        </div>
        <div className="ml-auto">
          <HealthStrip cloud={cloud.status} view={view} now={now} hasControl={lease.hasControl} lease={view?.lease} offlineCount={offlineRecs.length} />
        </div>
      </div>

      {offline && (
        <div className="rounded-md border border-bad bg-bad/15 px-4 py-2 font-bold text-red-800" role="alert">
          CLOUD OFFLINE — OFFLINE SCRIBING MODE. Bids are recorded on this laptop only and are NOT shown on the room display. Tell the auctioneer.
        </div>
      )}
      {runner.phase === 'confirming' && (
        <div className="rounded-md border border-warn bg-warn/15 px-4 py-2 font-semibold text-amber-900" role="status">
          Confirming last action with the cloud… (checking whether it was recorded — do not re-enter)
        </div>
      )}
      {anyFaultActive(faults) && (
        <div className="rounded-md border border-dashed border-warn/50 px-4 py-1.5 text-xs text-warn">Test faults are active (see Test tools).</div>
      )}
      {runner.error && (
        <ErrorNote onDismiss={runner.clearError}>
          <b>{runner.error.code.replace(/_/g, ' ')}:</b> {runner.error.message}
        </ErrorNote>
      )}

      {view && (
        <div className="grid grid-cols-12 gap-3">
          {/* Left — bidding */}
          <div className="col-span-12 flex flex-col gap-3 xl:col-span-8">
            <CurrentBidCard view={view} />
            <BidEntry
              currentCents={view.state.currentBidCents ? BigInt(view.state.currentBidCents) : null}
              defaultIncrementCents={BigInt(view.session.defaultIncrementCents)}
              canBid={canBid}
              disabledReason={bidDisabledReason}
              pending={runner.phase !== 'idle'}
              cloud={cloud.status}
              onSubmit={submitBid}
              onUndoShortcut={() => controlsEnabled && allowed.has('UNDO') && setDialog('UNDO')}
              onPauseShortcut={() => {
                if (!controlsEnabled) return
                if (allowed.has('PAUSE')) void run({ type: 'PAUSE' })
                else if (allowed.has('RESUME')) void run({ type: 'RESUME' })
              }}
            />
            <OfflinePanel records={offlineRecs} sessionId={view.session.id} offline={offline} />
          </div>

          {/* Right — controls & status */}
          <div className="col-span-12 flex flex-col gap-3 xl:col-span-4">
            <LeasePanel
              lease={view.lease}
              hasControl={lease.hasControl}
              error={lease.error}
              onAcquire={lease.acquire}
              onRelease={lease.release}
              onTakeover={lease.takeover}
              now={now}
            />
            <AuctionControls view={view} enabled={controlsEnabled} pending={runner.phase !== 'idle'} run={run} dialog={dialog} setDialog={setDialog} />
            <DisplayPanel view={view} now={now} cloudOk={cloudOk} />
            <div className="max-h-[340px] min-h-[160px]">
              <BidHistory bids={view.bids} />
            </div>
            <FaultPanel faults={faults} />
          </div>
        </div>
      )}

      {lease.lost && (
        <Modal title="Operator control lost" tone="danger" onClose={lease.dismissLost}>
          <p className="mb-4 text-ink-muted">
            {view?.lease ? <><b className="text-navy">{view.lease.userName}</b> now has control of this auction.</> : 'Your operator control expired while the cloud was unreachable.'} This console is read-only until you take control again.
          </p>
          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={lease.dismissLost}>
              OK
            </button>
            {!view?.lease && (
              <button
                className="btn-primary"
                onClick={async () => {
                  await lease.acquire()
                  lease.dismissLost()
                }}
              >
                Re-acquire control
              </button>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}
