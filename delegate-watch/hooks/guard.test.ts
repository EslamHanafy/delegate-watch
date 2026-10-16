import { test, expect } from 'claude-code/testing'
import { FRESH_BEAT, errorText, isTimeout, nextBeat, orElse, withTimeout } from './guard'
import { STALL_MS, beatLabel } from './summarize'

// a manual clock: timers fire only when the test says so
const manual = () => {
  const pending: { fn: () => void; live: boolean }[] = []
  const after = (_ms: number, fn: () => void) => {
    const t = { fn, live: true }
    pending.push(t)
    return { cancel: () => void (t.live = false) }
  }
  const fire = () => pending.filter(t => t.live).forEach(t => t.fn())
  return { after, fire, pending }
}

test('a call that answers in time resolves and its timer is cancelled', async () => {
  const c = manual()
  expect(await withTimeout(c.after, Promise.resolve(7), 1000, 'x')).toBe(7)
  expect(c.pending.every(t => !t.live)).toBe(true)
})

test('a call that never answers rejects with a TimeoutError naming it', async () => {
  const c = manual()
  const hung = withTimeout(c.after, new Promise<number>(() => {}), 10_000, 'list')
  c.fire()
  const err = await hung.catch(e => e)
  expect(isTimeout(err)).toBe(true)
  expect(errorText(err)).toBe('list timed out after 10s')
})

test('a call that fails keeps its own error', async () => {
  const c = manual()
  const err = await withTimeout(c.after, Promise.reject(new Error('boom')), 1000, 'x').catch(e => e)
  expect(errorText(err)).toBe('boom')
  expect(isTimeout(err)).toBe(false)
})

test('orElse hides an ordinary failure but not a hang', async () => {
  const c = manual()
  expect(await orElse(Promise.reject(new Error('missing')), [] as string[])).toEqual([])
  const hung = orElse(withTimeout(c.after, new Promise<string[]>(() => {}), 1000, 'list'), [])
  c.fire()
  expect(isTimeout(await hung.catch(e => e))).toBe(true)
})

test('errorText keeps one short line', () => {
  expect(errorText(new Error('a\n  b'))).toBe('a b')
  expect(errorText('x'.repeat(300)).length).toBe(120)
})

test('the heartbeat counts polls, keeps the last good time and records failures', () => {
  const ok = nextBeat(FRESH_BEAT, null, 100)
  expect(ok).toEqual({ okAt: 100, ticks: 1, errors: 0, error: '', errorAt: 0 })
  const bad = nextBeat(ok, new Error('find timed out after 11s'), 200)
  expect(bad).toEqual({ okAt: 100, ticks: 2, errors: 1, error: 'find timed out after 11s', errorAt: 200 })
  expect(nextBeat(bad, null, 300).okAt).toBe(300)
})

test('the header label says starting, fresh, failed or stalled', () => {
  expect(beatLabel(FRESH_BEAT, 5000).text).toBe('starting…')
  expect(beatLabel({ ...FRESH_BEAT, ticks: 3, okAt: 4000 }, 7000).text).toBe('refreshed 3s ago')
  expect(beatLabel({ ...FRESH_BEAT, ticks: 3, okAt: 4000 }, 4000 + STALL_MS + 1000).text).toBe('⚠ stalled, last refresh 31s ago')
  const failed = beatLabel({ okAt: 1000, ticks: 3, errors: 1, error: 'boom', errorAt: 2000 }, 5000)
  expect(failed.text).toBe('⚠ poll failed 3s ago: boom')
  expect(failed.color).toBe('red')
  // a later good poll clears the failure
  expect(beatLabel({ okAt: 6000, ticks: 4, errors: 1, error: 'boom', errorAt: 2000 }, 7000).isWarn).toBe(false)
})
