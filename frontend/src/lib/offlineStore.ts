/**
 * Offline provisional scribing store (IndexedDB). Records are NOT cloud
 * confirmed and are only imported after manual review (Phase 1E).
 */
import { uuid } from './ids'

export interface OfflineRecord {
  localId: string
  sessionId: string
  type: 'BID' | 'NOTE' | 'STATUS'
  amountCents: string | null
  note: string
  operatorId: string
  operatorName: string
  localCreatedAt: string
  cloudConfirmed: false
  reconciliation: 'PENDING'
}

const DB = 'gl-auction-offline'
const STORE = 'records'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore(STORE, { keyPath: 'localId' })
      s.createIndex('sessionId', 'sessionId')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function addOfflineRecord(
  r: Omit<OfflineRecord, 'localId' | 'localCreatedAt' | 'cloudConfirmed' | 'reconciliation'>,
): Promise<OfflineRecord> {
  const rec: OfflineRecord = {
    ...r,
    localId: uuid(),
    localCreatedAt: new Date().toISOString(),
    cloudConfirmed: false,
    reconciliation: 'PENDING',
  }
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(rec)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
  return rec
}

export async function listOfflineRecords(sessionId: string): Promise<OfflineRecord[]> {
  const db = await open()
  const rows = await new Promise<OfflineRecord[]>((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).index('sessionId').getAll(sessionId)
    req.onsuccess = () => resolve(req.result as OfflineRecord[])
    req.onerror = () => reject(req.error)
  })
  db.close()
  return rows.sort((a, b) => a.localCreatedAt.localeCompare(b.localCreatedAt))
}

export function downloadFile(name: string, content: string, type = 'application/json') {
  const blob = new Blob([content], { type })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
