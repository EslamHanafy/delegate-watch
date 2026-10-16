import type { Beat } from '../types'

// the one timer shape the guard needs, so it can be tested without the engine (`$.clock.after` fits)
export type After = (ms: number, fn: () => void) => { cancel: () => void }

const TIMEOUT = 'TimeoutError'
const ERROR_WIDTH = 120

// settles like `work`, but rejects with a TimeoutError once `ms` pass first, so one host call that never answers cannot hold the poll
export const withTimeout = <T>(after: After, work: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = after(ms, () => {
      const err = new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)
      err.name = TIMEOUT
      reject(err)
    })
    work.then(
      v => {
        timer.cancel()
        resolve(v)
      },
      err => {
        timer.cancel()
        reject(err)
      },
    )
  })

export const isTimeout = (err: unknown): boolean => err instanceof Error && err.name === TIMEOUT

// a fallback for a call that may fail (a missing file, a folder that vanished), but never for a call that hung: that must reach the heartbeat
export const orElse = <T>(work: Promise<T>, fallback: T): Promise<T> =>
  work.catch(err => {
    if (isTimeout(err)) throw err
    return fallback
  })

// one line of text for any thrown value
export const errorText = (err: unknown): string => {
  const raw = err instanceof Error ? err.message : String(err)
  const one = raw.replace(/\s+/g, ' ').trim()
  return one.length > ERROR_WIDTH ? `${one.slice(0, ERROR_WIDTH - 1)}…` : one
}

export const FRESH_BEAT: Beat = { okAt: 0, ticks: 0, errors: 0, error: '', errorAt: 0 }

// the heartbeat after one poll ended at `at`: `failure` is what it threw, or null when it completed
export const nextBeat = (prev: Beat, failure: unknown, at: number): Beat =>
  failure === null
    ? { ...prev, ticks: prev.ticks + 1, okAt: at }
    : { ...prev, ticks: prev.ticks + 1, errors: prev.errors + 1, errorAt: at, error: errorText(failure) }
