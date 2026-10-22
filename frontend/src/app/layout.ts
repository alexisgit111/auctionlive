/**
 * Console layout: the phone ("calculator") layout is used automatically on narrow screens.
 * Staff can force either layout; the choice is remembered on that device.
 */
import { useEffect, useSyncExternalStore } from 'react'

export type LayoutPref = 'auto' | 'mobile' | 'desktop'
const KEY = 'gl-console-layout'
const EVT = 'gl-console-layout-change'
// phones, plus touch tablets (iPad / Android, portrait or landscape) — mouse-driven computers keep the desktop console
const QUERY = '(max-width: 767px), (pointer: coarse) and (max-width: 1400px)'

function readPref(): LayoutPref {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'mobile' || v === 'desktop' ? v : 'auto'
  } catch {
    return 'auto'
  }
}

export function setLayoutPref(p: LayoutPref) {
  try {
    if (p === 'auto') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, p)
  } catch {
    /* private mode — keep for this page only */
  }
  window.dispatchEvent(new Event(EVT))
}

function subscribe(cb: () => void) {
  const mq = window.matchMedia(QUERY)
  mq.addEventListener('change', cb)
  window.addEventListener(EVT, cb)
  window.addEventListener('storage', cb)
  return () => {
    mq.removeEventListener('change', cb)
    window.removeEventListener(EVT, cb)
    window.removeEventListener('storage', cb)
  }
}

const snapshot = () => {
  const pref = readPref()
  const narrow = window.matchMedia(QUERY).matches
  return `${pref}|${narrow ? 1 : 0}`
}

export function useConsoleLayout(): { mobile: boolean; pref: LayoutPref } {
  const snap = useSyncExternalStore(subscribe, snapshot, () => 'auto|0')
  const [pref, narrow] = snap.split('|') as [LayoutPref, string]
  // ?layout=mobile|desktop|auto in the address bar sets the preference (handy for testing on a laptop)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('layout')
    if (q === 'mobile' || q === 'desktop' || q === 'auto') setLayoutPref(q)
  }, [])
  return { mobile: pref === 'mobile' || (pref === 'auto' && narrow === '1'), pref }
}
