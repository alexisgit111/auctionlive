/**
 * Interval that keeps ticking when the tab is in the background or its window is covered.
 *
 * Browsers throttle setInterval in hidden tabs (Chrome: down to once per minute after a
 * few minutes). That would let the operator lease and display heartbeats lapse whenever
 * staff switch windows. Timers inside a dedicated Worker are not throttled that way, so
 * the worker sends a tick and the callback runs on the page.
 */
const WORKER_SRC = 'let t=null;onmessage=e=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data)}'
let workerUrl: string | null = null

export function setWorkerInterval(fn: () => void, ms: number): () => void {
  try {
    if (typeof Worker === 'undefined') throw new Error('no worker')
    workerUrl ??= URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }))
    const w = new Worker(workerUrl)
    w.onmessage = () => fn()
    w.postMessage(ms)
    return () => {
      w.postMessage(0)
      w.terminate()
    }
  } catch {
    const t = setInterval(fn, ms)
    return () => clearInterval(t)
  }
}
