import { test, expect, mock } from 'claude-code/testing'

const run = { dir: '/x/run1', name: 'run1', agent: 'opencode', model: 'm', startedAt: 1, finishedAt: 0, updatedAt: 5, status: 'running', isDone: false, touched: null, tools: 3, cost: 0.1, note: '', turns: 0, lastTurn: 0, blocked: '', procs: [] }
const evs = [
  { t: 2000, kind: 'tool', tag: 'read', text: '/a/b/c.ts' },
  { t: 3000, kind: 'say', tag: 'say', text: 'hello there' },
  { t: 4000, kind: 'think', tag: 'think', text: 'hmm\nmore' },
]

test('pane draws with a run on the terminal', async ($, on) => {
  mock.clock(on, { now: 10_000 })
  const vals: Record<string, unknown> = { runs: [run], selected: '/x/run1', events: evs, rowsPref: 8, scroll: 0, paused: false, filter: 'all', expanded: [], beat: { okAt: 7_000, ticks: 5, errors: 0, error: '', errorAt: 0 } }
  on('state.get', (_$: never, e: never) => ({ value: vals[(e as { key: string }).key], version: 1 }) as never)
  on('state.set', (_$: never, e: never) => ({ isSet: true, version: 2 }) as never)
  for (const viewport of [{ columns: 200, rows: 50 }, { columns: 80, rows: 24, isFullscreen: false }]) {
    const ui = await $.ui.mount({ plugin: 'delegate-watch', surface: 'terminal', component: 'Pane', requestId: 'delegate-watch', props: {}, viewport } as never)
    expect(await ui.find({ type: 'Text', text: /Watching/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /TIMELINE/ })).toBeDefined()
    // the header always carries the watcher's pulse beside Pause / Resume
    expect(await ui.find({ type: 'Text', text: /refreshed|starting|stalled|failed/ })).toBeDefined()
    await ui.unmount()
  }
})
