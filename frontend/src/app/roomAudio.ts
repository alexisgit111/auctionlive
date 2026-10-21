/** What the room screen's speakers are doing — reported to the console with the display heartbeat. */
import type { AudioStatus } from '../engine/types'

let status: AudioStatus = 'off'
const listeners = new Set<(s: AudioStatus) => void>()

export function setAudioStatus(s: AudioStatus) {
  if (s === status) return
  status = s
  listeners.forEach((l) => l(s))
}

export const getAudioStatus = (): AudioStatus => status

export function onAudioStatus(l: (s: AudioStatus) => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
