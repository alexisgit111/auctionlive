/**
 * Property photos live in IndexedDB (large quota), not in the localStorage "database".
 * Sessions and display payloads carry only a short reference: `idb-image:<id>`.
 * Phase 1B: replaced by an uploaded file URL on the server / CDN.
 */
import { useEffect, useState } from 'react'
import { uuid } from './ids'

export const IMAGE_REF_PREFIX = 'idb-image:'
const DB = 'gl-auction-images'
const STORE = 'images'
const cache = new Map<string, string>()

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

let uploader: ((dataUrl: string) => Promise<string>) | null = null

/** The app decides where images go: this browser's IndexedDB (mock) or the server (http). */
export function setImageUploader(fn: (dataUrl: string) => Promise<string>) {
  uploader = fn
}

/** Store an image and return the reference to save on the session. */
export async function putImage(dataUrl: string): Promise<string> {
  const ref = uploader ? await uploader(dataUrl) : await putLocalImage(dataUrl)
  cache.set(ref, dataUrl)
  return ref
}

/** IndexedDB storage — this browser only (prototype mode). */
export async function putLocalImage(dataUrl: string): Promise<string> {
  const id = uuid()
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(dataUrl, id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
  const ref = IMAGE_REF_PREFIX + id
  cache.set(ref, dataUrl)
  return ref
}

export async function resolveImage(ref: string): Promise<string | null> {
  if (!ref.startsWith(IMAGE_REF_PREFIX)) return ref // plain URL or legacy data URI
  const hit = cache.get(ref)
  if (hit) return hit
  const db = await open()
  const v = await new Promise<string | null>((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(ref.slice(IMAGE_REF_PREFIX.length))
    req.onsuccess = () => resolve((req.result as string) ?? null)
    req.onerror = () => reject(req.error)
  })
  db.close()
  if (v) cache.set(ref, v)
  return v
}

export function useImage(ref: string | null | undefined): string | null {
  const [src, setSrc] = useState<string | null>(() => (ref ? (cache.get(ref) ?? (ref.startsWith(IMAGE_REF_PREFIX) ? null : ref)) : null))
  useEffect(() => {
    let alive = true
    if (!ref) return setSrc(null)
    resolveImage(ref)
      .then((v) => alive && setSrc(v))
      .catch(() => alive && setSrc(null))
    return () => {
      alive = false
    }
  }, [ref])
  return src
}
