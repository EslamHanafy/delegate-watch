import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Beat, Ev, Filter, Run } from '../types'
import { FRESH_BEAT, nextBeat, orElse, withTimeout } from './guard'
import {
  MAX_EVENTS, agentOf, ago, beatLabel, blockedOf, childrenOf, clock, editsSince, glyph, mixOf, parseAgyLines, parseLines, parseStat, rel, expandCap, fitRows, fitText, spark, splitPath, startOf, tintOf, topLines, weightOf,
} from './summarize'
import type { Proc, Snap, Totals } from './summarize'
import { anchorsOf, mergeCands, resolveRoots, searchedHint } from './roots'
import type { Cand } from './roots'

const PANE = 'delegate-watch'
const POLL_MS = 2000
const SLOW_EVERY = 4
const FIND_EVERY = 3
const IDLE_EVERY = 5
const ROWS_STEP = 5
const ROWS_MAX = 200
const CALL_MS = 10_000
const PROC_GUARD_MS = 3_000
const REDRAW_MS = 5_000
const MAX_READ = 8 * 1024 * 1024
const STALE_MS = 15 * 60 * 1000
const STAT = "if [ \"$(uname)\" = Darwin ]; then xargs -0 stat -f '%m %N'; else xargs -0 stat -c '%Y %n'; fi"
const GOOD = ['success', 'completed', 'done', 'finished']

const runs = atom({ plugin: 'delegate-watch', key: 'runs' } as const, [] as Run[])
const selected = atom({ plugin: 'delegate-watch', key: 'selected' } as const, null as string | null)
const events = atom({ plugin: 'delegate-watch', key: 'events' } as const, [] as Ev[])
// scroll: 0 follows the newest event (live); n > 0 pins the view to end at event n, so new events cannot move it
const scroll = atom({ plugin: 'delegate-watch', key: 'scroll' } as const, 0)
const paused = atom({ plugin: 'delegate-watch', key: 'paused' } as const, false)
const filter = atom({ plugin: 'delegate-watch', key: 'filter' } as const, 'all' as Filter)
const expanded = atom({ plugin: 'delegate-watch', key: 'expanded' } as const, [] as string[])
const rowsPref = atom({ plugin: 'delegate-watch', key: 'rowsPref' } as const, -1)
const beat = atom({ plugin: 'delegate-watch', key: 'beat' } as const, FRESH_BEAT as Beat)
// the cwd the session started in: kept in session state so a reload (which runs session.start again) does not move it
const startCwd = atom({ plugin: 'delegate-watch', key: 'startCwd' } as const, '')
// the absolute folders the last search looked in, shown when it found nothing
const searched = atom({ plugin: 'delegate-watch', key: 'searched' } as const, [] as string[])

type Data = {
  offset: number
  carry: string
  evs: Ev[]
  totals: Totals
  snap: Snap | null
  note: string
  blocked: string
  procs: Proc[]
}

export const register: Register = (on, options) => {
  const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/[\n,]/) : [])
  const watch = asList(options.watchPaths).map(x => x.trim()).filter(Boolean)
  const depth = Math.min(12, Math.max(1, Math.floor(Number(options.searchDepth) || 6)))
  const clampRows = (n: number) => Math.min(ROWS_MAX, Math.max(0, Math.floor(n) || 0))
  const configRows = clampRows(Number(options.timelineRows ?? 8))
  const maxRuns = Math.min(12, Math.max(1, Math.floor(Number(options.maxSessions) || 3)))
  const maxMin = Math.max(1, Math.floor((Number(options.maxAgeHours) || 6) * 60))
  const data = new Map<string, Data>()
  const agents = new Map<string, Run['agent']>()
  const results = new Map<string, { status: string; touched: number | null; model: string; started: number; finishedAt: number }>()
  const finished = new Set<string>()
  const announced = new Set<string>()
  let isPolling = false
  let hasOpened = false
  let isPaneOpen = false
  let tick = 0
  let lastSig = ''
  let cands: Cand[] = []
  // run folders whose log is no longer there; a search that finds one again brings it back
  const gone = new Set<string>()
  // repository root per folder (null when the folder is not in a git work tree)
  const gitTops = new Map<string, string | null>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'delegate-watch',
      description: 'Open the live delegate pane, or pause / resume the watcher',
      argumentHint: 'pause | resume',
    })
    await update($, runs, () => [])
    await update($, events, () => [])
    await update($, selected, () => null)
    await update($, scroll, () => 0)
    await update($, paused, () => false)
    await update($, expanded, () => [])
    await update($, beat, () => FRESH_BEAT)
    await update($, searched, () => [])
    const firstCwd = await $.session.cwd()
    await update($, startCwd, prev => prev || firstCwd)
    if ((await $.store.get('paused')) === true) await update($, paused, () => true)
    const savedRows = await $.store.get('timelineRows')
    await update($, rowsPref, () => (typeof savedRows === 'number' ? clampRows(savedRows) : configRows))

    // every host call goes through here: one that never answers rejects after `ms` instead of holding the poll forever
    const call = <T,>(label: string, work: Promise<T>, ms = CALL_MS): Promise<T> => withTimeout((n, fn) => $.clock.after(n, fn), work, ms, label)
    // a process gets its own timeout first, the guard only catches a call that does not even honour that
    const exec = (label: string, argv: string[], init: { cwd?: string; timeoutMs: number }) =>
      call(label, $.process.run(argv, init), init.timeoutMs + PROC_GUARD_MS)
    // the repository root of a folder, asked once per folder; null outside a work tree or when git fails
    const topOf = async (dir: string): Promise<string | null> => {
      if (gitTops.has(dir)) return gitTops.get(dir) ?? null
      const ran = await exec('git root', ['git', '-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 3000 }).catch(() => null)
      const top = ran?.stdout.trim() || null
      gitTops.set(dir, top)
      return top
    }

    // records how a poll ended; best effort, it must never throw or it would defeat the point of a heartbeat
    const recordBeat = async (failure: unknown): Promise<void> => {
      try {
        const at = await call('clock', $.clock.now()).catch(() => Date.now())
        await call('heartbeat', update($, beat, prev => nextBeat({ ...FRESH_BEAT, ...prev }, failure, at)))
      } catch {
        // nothing left to report to
      }
    }

    // while the pane is open its age label has to keep counting even if the poll is the thing that stopped
    $.clock.every(REDRAW_MS, () => {
      if (isPaneOpen) $.ui.invalidate('ui.render')
    })

    $.clock.every(POLL_MS, async () => {
      if (isPolling) return
      isPolling = true
      tick += 1
      let failure: unknown = null
      let isCounted = true
      try {
        if (await call('paused', read($, paused))) {
          isCounted = false
          return
        }
        const cwd = await call('cwd', $.session.cwd())
        const tmp = ((await call('env', $.env.get('TMPDIR'))) ?? '/tmp').replace(/\/$/, '')
        const wasLive = (await call('runs', read($, runs))).some(x => !x.isDone)
        if (!wasLive && tick % IDLE_EVERY !== 0) return
        const now = await call('clock', $.clock.now())
        const isSlow = tick % SLOW_EVERY === 0

        // discovery: one `find` for every run folder touched in the last 6 hours, refreshed every few ticks
        if (cands.length === 0 || tick % FIND_EVERY === 0 || tick <= 1) {
          const home = (await call('env', $.env.get('HOME'))) ?? ''
          // relative paths are resolved against the repository root and the start cwd too: the live cwd moves
          const anchors = anchorsOf(await call('start cwd', read($, startCwd)), cwd, await topOf(cwd))
          const roots = resolveRoots(watch.length > 0 ? watch : ['$TMPDIR/delegate-relay', '.orchestrator', '.superpowers'], anchors, tmp, home)
          await call('searched', update($, searched, () => roots))
          // a failing `find` is not "nothing running": it throws so the heartbeat shows it
          const ran = await exec(
            'find',
            ['sh', '-c', `find ${roots.map(x => `'${x.replace(/'/g, '')}'`).join(' ')} -maxdepth ${depth} \\( -name events.jsonl -o -name agy.log \\) -mmin -${maxMin} -print0 2>/dev/null | ${STAT} 2>/dev/null`],
            { timeoutMs: 8000 },
          )
          const seenDirs = new Set<string>()
          const fresh: Cand[] = []
          for (const l of ran.stdout.split('\n')) {
            const sp = l.indexOf(' ')
            const path = l.slice(sp + 1)
            const dir = path.slice(0, path.lastIndexOf('/'))
            if (sp < 1 || dir === '' || seenDirs.has(dir)) continue
            seenDirs.add(dir)
            fresh.push({ dir, name: dir.slice(dir.lastIndexOf('/') + 1), mtime: Number(l.slice(0, sp)) * 1000 })
          }
          for (const c of fresh) gone.delete(c.dir)
          cands = mergeCands(cands, fresh, gone, now - maxMin * 60_000)
        }

        const found: Run[] = []
        for (const c of cands.slice(0, maxRuns)) {
          const files = await orElse(call('list', $.fs.list(c.dir)), [])
          const names = files.map(f => f.name)
          const logName = names.includes('agy.log') ? 'agy.log' : names.includes('events.jsonl') ? 'events.jsonl' : null
          if (logName === null) {
            // the folder or its log went away: stop keeping it until a search finds it again
            gone.add(c.dir)
            continue
          }
          const log = files.find(f => f.name === logName)!
          c.mtime = log.mtimeMs
          const brief = files.find(f => f.name === 'brief.txt')
          let agent: Run['agent'] = agents.get(c.dir) ?? (logName === 'agy.log' ? 'agy' : 'unknown')
          if (agent === 'unknown' && log.size > 0) {
            const head = await exec('head', ['head', '-c', '1500', `${c.dir}/events.jsonl`], { timeoutMs: 3000 }).catch(() => null)
            agent = agentOf(names, head?.stdout ?? '')
            if (agent !== 'unknown') agents.set(c.dir, agent)
          }
          let status = 'running'
          let model = ''
          let started = 0
          let finishedAt = 0
          let touched: number | null = null
          let isDone = false
          if (names.includes('result.json')) {
            isDone = true
            let hit = results.get(c.dir)
            if (!hit) {
              try {
                const result = JSON.parse(await call('read result', $.fs.read(`${c.dir}/result.json`)))
                hit = {
                  status: String(result.status ?? 'done'),
                  touched: Array.isArray(result.touchedFiles) ? result.touchedFiles.length : null,
                  model: String(result.resolvedModel ?? result.model ?? ''),
                  started: Date.parse(result.startedAt ?? '') || 0,
                  finishedAt: Date.parse(result.finishedAt ?? '') || 0,
                }
                results.set(c.dir, hit)
              } catch {
                hit = { status: 'done', touched: null, model: '', started: 0, finishedAt: 0 }
              }
            }
            status = hit.status
            touched = hit.touched
            model = hit.model
            started = hit.started
            finishedAt = hit.finishedAt
          } else if (names.includes('final.txt') && agent !== 'claude' && !names.includes('profile.json')) {
            // the Claude relay (its folder alone has profile.json) creates an empty final.txt when the run starts,
            // so only result.json ends a Claude run, also before its first event names the agent
            isDone = true
            status = 'finished'
          } else if (now - log.mtimeMs > STALE_MS && agent !== 'agy') {
            status = `stalled ${ago(now - log.mtimeMs)}`
          }
          const d = data.get(c.dir) ?? {
            offset: 0, carry: '', evs: [], totals: { tools: 0, cost: 0, turns: 0, lastTurn: 0, think: '' }, snap: null, note: '', blocked: '', procs: [],
          }
          data.set(c.dir, d)
          found.push({
            dir: c.dir,
            name: c.name,
            agent,
            model,
            finishedAt,
            startedAt: started || (brief?.mtimeMs ?? startOf(c.name) ?? log.mtimeMs),
            updatedAt: log.mtimeMs,
            status,
            isDone,
            touched,
            tools: d.totals.tools,
            cost: d.totals.cost,
            note: d.note,
            turns: d.totals.turns,
            lastTurn: d.totals.lastTurn,
            blocked: d.blocked,
            procs: d.procs,
          })
        }

        if (gone.size > 0) cands = cands.filter(c => !gone.has(c.dir))

        // pick the run to show: the user's choice, else the newest running, else the newest
        let sel = await call('selected', read($, selected))
        if (!found.some(r => r.dir === sel)) {
          sel = (found.find(r => !r.isDone) ?? found[0])?.dir ?? null
          await call('selected', update($, selected, () => sel))
          await call('scroll', update($, scroll, () => 0))
        }

        // only the shown run is read, and only the bytes added since the last tick
        const run = found.find(r => r.dir === sel)
        if (run) {
          const d = data.get(run.dir)!
          const logFile = run.agent === 'agy' ? 'agy.log' : 'events.jsonl'
          const files = await orElse(call('list', $.fs.list(run.dir)), [])
          const size = files.find(f => f.name === logFile)?.size ?? 0
          if (size > d.offset) {
            const from = Math.max(d.offset, size - MAX_READ)
            try {
              const ran = await exec('tail', ['tail', '-c', `+${from + 1}`, `${run.dir}/${logFile}`], { timeoutMs: 8000 })
              let text = d.carry + ran.stdout
              if (d.offset === 0 && from > 0) text = text.slice(text.indexOf('\n') + 1)
              const cut = text.lastIndexOf('\n')
              d.carry = cut >= 0 ? text.slice(cut + 1) : text
              const lines = cut >= 0 ? text.slice(0, cut).split('\n') : []
              if (run.agent === 'agy') parseAgyLines(lines, d.evs, d.totals, new Date(now).getFullYear())
              else parseLines(lines, d.evs, d.totals, now)
              d.offset = size
              d.note = ''
            } catch {
              d.note = 'cannot read the log here'
            }
          }
          if (run.agent === 'agy' && (isSlow || d.snap === null)) {
            // the run's own repository, not the live cwd (which may be a subfolder or another checkout)
            const repo = (await topOf(run.dir)) ?? cwd
            try {
              if (d.snap === null || !run.isDone) {
                const ran = await exec(
                  'git',
                  ['sh', '-c', `git ls-files -m -o --exclude-standard -z | ${STAT} 2>/dev/null`],
                  { cwd: repo, timeoutMs: 8000 },
                )
                const snap = parseStat(ran.stdout)
                d.evs.push(...editsSince(d.snap, snap, run.startedAt, ''))
                d.snap = snap
              }
              if (!run.isDone && !run.dir.includes("'")) {
                const ps = await exec(
                  'ps',
                  ['sh', '-c', `pgrep -f '${run.dir}/[a]gy.log'; echo @@; ps -axo pid=,ppid=,etime=,command=`],
                  { timeoutMs: 5000 },
                )
                d.procs = childrenOf(ps.stdout)
                d.blocked = blockedOf(await orElse(call('read stderr', $.fs.read(`${run.dir}/stderr.txt`)), ''))
              } else {
                d.procs = []
                d.blocked = ''
              }
            } catch {
              d.note = 'git or ps unavailable here'
            }
          }
          if (d.evs.length > MAX_EVENTS) d.evs.splice(0, d.evs.length - MAX_EVENTS)
          run.tools = run.agent === 'agy' ? new Set(d.evs.filter(x => x.kind === 'file').map(x => x.text)).size : d.totals.tools
          run.cost = d.totals.cost
          run.note = d.note
          run.turns = d.totals.turns
          run.lastTurn = d.totals.lastTurn
          run.blocked = d.blocked
          run.procs = d.procs
        }

        const sig = `${sel}|${run ? data.get(run.dir)!.evs.length : 0}|${run?.blocked}|${run?.procs.map(x => x.age + x.cmd).join(',')}|${found.map(r => r.dir + r.status + r.updatedAt).join(',')}`
        if (sig !== lastSig) {
          await call('write runs', update($, runs, () => found))
          // no run shown: clear the timeline too, so an empty run list never sits above an old timeline
          const list = run ? data.get(run.dir)!.evs.slice().sort((a, b) => a.t - b.t) : []
          await call('write events', update($, events, () => list))
          // remembered only once both writes landed, so a failed write is retried on the next tick
          lastSig = sig
        }

        for (const r of found) {
          if (!r.isDone && !finished.has(r.dir) && !announced.has(r.dir)) {
            announced.add(r.dir)
            hasOpened = true
            isPaneOpen = true
            void $.ui.open({ id: PANE, title: 'Delegates' }).then(o => {
              if (!o.isPlaced) $.ui.toast(`delegate-watch: run started, type /delegate-watch to open the pane (${o.reason})`)
            })
          }
          if (r.isDone && !finished.has(r.dir)) {
            finished.add(r.dir)
            if (hasOpened) $.ui.toast(`${r.agent} ${r.name}: ${r.status}`)
          }
        }
        const live = found.filter(r => !r.isDone).length
        $.ui.status(live > 0 ? `${live} delegate${live > 1 ? 's' : ''} running` : undefined)
      } catch (err) {
        // whatever broke (a hung host call, a bad read) ends this poll only; the next tick starts clean
        failure = err
      } finally {
        isPolling = false
        if (isCounted) await recordBeat(failure)
      }
    })
    return next(e)
  })

  on('command.run', { command: 'delegate-watch' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'pause' || arg === 'stop') {
      await update($, paused, () => true)
      await $.store.set('paused', true)
      $.ui.status(undefined)
      return { text: 'Delegate watcher paused. It reads no files until you run /delegate-watch resume.' }
    }
    if (arg === 'resume' || arg === 'start') {
      await update($, paused, () => false)
      await $.store.set('paused', false)
      lastSig = ''
      cands = []
      gone.clear()
      gitTops.clear()
      isPaneOpen = true
      await $.ui.open({ id: PANE, title: 'Delegates' })
      return { text: 'Delegate watcher resumed.' }
    }
    isPaneOpen = true
    const opened = await $.ui.open({ id: PANE, title: 'Delegates' })
    return { text: opened.isPlaced ? 'Delegates pane opened.' : `Delegates pane is open but not drawn: ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list: Run[] = (await read($, runs)).map((x: Partial<Run>) => ({
      dir: String(x.dir ?? ''), name: String(x.name ?? ''), agent: x.agent ?? 'unknown', model: x.model ?? '',
      startedAt: x.startedAt ?? 0, finishedAt: x.finishedAt ?? 0, updatedAt: x.updatedAt ?? 0,
      status: String(x.status ?? 'running'), isDone: x.isDone ?? false, touched: x.touched ?? null,
      tools: x.tools ?? 0, cost: x.cost ?? 0, note: x.note ?? '', turns: x.turns ?? 0, lastTurn: x.lastTurn ?? 0,
      blocked: x.blocked ?? '',
      procs: (Array.isArray(x.procs) ? x.procs : []).filter(
        (q): q is Proc => typeof q === 'object' && q !== null && typeof q.age === 'string' && typeof q.cmd === 'string',
      ),
    }))
    const sel = await read($, selected)
    const all: Ev[] = (await read($, events))
      .filter((x: Partial<Ev>) => typeof x === 'object' && x !== null && typeof x.text === 'string')
      .map((x: Ev) => ({ ...x, tag: typeof x.tag === 'string' ? x.tag : x.kind }))
    const back = await read($, scroll)
    const f = await read($, filter)
    const isPaused = await read($, paused)
    const hint = searchedHint(await read($, searched))
    const now = await $.clock.now()
    const pulse = beatLabel({ ...FRESH_BEAT, ...(await read($, beat)) }, now)
    const run = list.find(r => r.dir === sel)
    const isAgy = run?.agent === 'agy'
    const open = new Set(await read($, expanded))
    const flip = (id: string) => update($, expanded, l => (l.includes(id) ? [] : [id]))
    const stored = await read($, rowsPref)
    const timelineRows = stored < 0 ? configRows : stored
    const setRows = (n: number) => {
      const v = clampRows(n)
      void update($, rowsPref, () => v)
      void $.store.set('timelineRows', v)
    }
    const keep = (x: Ev) =>
      f === 'all' || (f === 'tools' ? x.kind === 'tool' || x.kind === 'file' || x.kind === 'err' : f === 'say' ? x.kind === 'say' || x.kind === 'think' : x.kind === 'turn')
    const shown = all.filter(keep)
    const isLive = back === 0
    const end = isLive ? shown.length : Math.min(back, shown.length)
    const mix = mixOf(all)
    const idOf = (x: Ev) => `${x.t}|${x.kind}|${x.text.slice(0, 48)}`
    const used = topLines({
      hasRuns: list.length > 0, hasRun: run !== undefined, isDone: run?.isDone ?? true, isAgy, hasBlocked: Boolean(run?.blocked),
      activeProcs: run?.procs.filter(x => !x.isHelper).length ?? 0, helperProcs: run?.procs.filter(x => x.isHelper).length ?? 0,
      hasNote: Boolean(run?.note), mixTags: mix.length, hasSpark: all.length > 1,
    })
    const cols = e.viewport?.columns ?? 60
    const budget = (e.viewport?.rows ?? 40) - used - 1
    const textCols = cols - 44
    const rows = timelineRows > 0 ? timelineRows : fitRows(shown, end, budget, open, idOf, textCols)
    const view = shown.slice(Math.max(0, end - rows), end)
    const step = Math.max(1, Math.floor(rows / 2))
    const brand = { agy: '#60a5fa', claude: '#d97757', cursor: '#94a3b8', opencode: '#34d399', unknown: 'gray' }
    const tone = !run
      ? 'gray'
      : run.status === 'running' || run.status.startsWith('stalled')
        ? 'yellow'
        : GOOD.includes(run.status)
          ? 'green'
          : 'red'
    const mark = (r: Run) => (!r.isDone ? '●' : GOOD.includes(r.status) ? '✓' : '✗')
    const pick = (r: Run) => {
      void update($, selected, () => r.dir)
      void update($, scroll, () => 0)
      void update($, events, () => [])
      void update($, expanded, () => [])
    }
    const tab = (label: string, value: Filter) => (
      <Button key={value} variant={f === value ? 'primary' : 'secondary'} onPress={() => {
        void update($, scroll, () => 0)
        void update($, filter, () => value)
      }}>
        {label}
      </Button>
    )
    const tile = (label: string, value: string, color?: string) => (
      <Box key={label} flexDirection="column" borderStyle="round" borderColor="gray" borderDimColor paddingX={1} minWidth={11}>
        <Text dimColor>{label}</Text>
        <Text bold color={color}>{value}</Text>
      </Box>
    )
    const badge = (tag: string, color: string) => (
      <Text bold inverse color={color}>{` ${tag.toUpperCase().slice(0, 6).padEnd(6)} `}</Text>
    )
    const toggle = async () => {
      const next = !isPaused
      await update($, paused, () => next)
      await $.store.set('paused', next)
      if (next) $.ui.status(undefined)
      else {
        lastSig = ''
        cands = []
        gone.clear()
        gitTops.clear()
      }
    }
    const mixTotal = mix.reduce((n, [, c]) => n + c, 0)
    const idleFor = run && run.lastTurn > 0 ? ago(now - run.lastTurn) : null
    const span = (run ? (run.isDone && run.finishedAt > 0 ? run.finishedAt : run.isDone ? run.updatedAt : now) : now) - (run?.startedAt ?? now)

    return (
      <Box flexDirection="column" gap={1}>
        <Box justifyContent="space-between">
          <Text bold color={isPaused ? 'yellow' : 'green'}>{isPaused ? '⏸ Watcher paused, not reading any files' : '● Watching delegates'}</Text>
          <Box gap={1} flexShrink={1} minWidth={0}>
            {isPaused ? null : <Text color={pulse.color} bold={pulse.isWarn} wrap="truncate-end">{pulse.text}</Text>}
            <Button key="pause" variant={isPaused ? 'primary' : 'secondary'} onPress={toggle}>{isPaused ? 'Resume' : 'Pause'}</Button>
          </Box>
        </Box>

        {list.length === 0 && (
          <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={2} paddingY={1}>
            <Text bold>No delegate runs yet</Text>
            <Text dimColor>Dispatch one with /agy-delegate, /claude-delegate, /cursor-delegate or /opencode-delegate and it shows up here.</Text>
            {hint === null ? null : <Text dimColor>{hint}</Text>}
          </Box>
        )}

        <Box gap={1} flexWrap="wrap">
          {list.map(r => (
            <Button key={r.dir} variant={r.dir === sel ? 'primary' : 'secondary'} onPress={() => pick(r)}>
              {`${mark(r)} ${r.agent} · ${r.name}`}
            </Button>
          ))}
        </Box>

        {run && (
          <Box flexDirection="column" borderStyle="round" borderColor={tone} paddingX={2} paddingY={1} gap={1}>
            <Box justifyContent="space-between">
              <Box gap={1}>
                {badge(run.agent, brand[run.agent])}
                <Text bold>{run.name}</Text>
                {run.model ? <Text dimColor>{run.model}</Text> : null}
              </Box>
              <Text bold inverse color={tone}>{` ${mark(run)} ${run.status.toUpperCase()} `}</Text>
            </Box>

            <Box gap={1} flexWrap="wrap">
              {tile('ELAPSED', ago(span))}
              {isAgy ? tile('MODEL TURNS', String(run.turns)) : tile('TOOL CALLS', String(run.tools))}
              {isAgy ? tile('FILES EDITED', String(run.tools)) : tile('COST', run.cost > 0 ? `$${run.cost.toFixed(2)}` : '—')}
              {run.touched !== null ? tile('IN DIFF', String(run.touched)) : null}
            </Box>

            {!run.isDone && isAgy && (
              <Box flexDirection="column">
                {run.blocked ? (
                  <Text color="yellow" bold>⏸ Idle · blocked on a background command</Text>
                ) : (
                  <Text color="green" bold>{idleFor ? `● Model active ${idleFor} ago` : '○ Waiting for the first model turn'}</Text>
                )}
                {run.blocked ? <Text dimColor>{run.blocked}</Text> : null}
                {run.procs.filter(x => !x.isHelper).length === 0 && !run.blocked ? (
                  <Text dimColor>{'  '}no command running, the model is thinking</Text>
                ) : null}
                {run.procs.filter(x => !x.isHelper).map((p, i) => (
                  <Box key={`p${i}`} gap={1}>
                    <Text color="green">{'  ▸'}</Text>
                    <Text dimColor>{p.age.padStart(6)}</Text>
                    <Text wrap="truncate-end">{p.cmd}</Text>
                  </Box>
                ))}
                {run.procs.filter(x => x.isHelper).map((p, i) => (
                  <Box key={`h${i}`} gap={1}>
                    <Text dimColor>{'  ·'}</Text>
                    <Text dimColor>{p.age.padStart(6)}</Text>
                    <Text dimColor wrap="truncate-end">{p.cmd} (helper)</Text>
                  </Box>
                ))}
              </Box>
            )}
            {!run.isDone && !isAgy && <Text color="green" bold>● Log updated {ago(now - run.updatedAt)} ago</Text>}
            {run.note ? <Text color="red">{run.note}</Text> : null}

            {mixTotal > 0 && (
              <Box flexDirection="column">
                <Box width="100%" height={1} overflow="hidden">
                  {mix.map(([tag, n]) => (
                    <Box key={tag} flexGrow={weightOf(n)} minWidth={1} height={1} backgroundColor={tintOf(tag)} />
                  ))}
                </Box>
                <Box gap={2} flexWrap="wrap">
                  {mix.map(([tag, n]) => (
                    <Text key={tag}><Text color={tintOf(tag)}>■</Text> {tag} <Text dimColor>{n} · {Math.round((n / mixTotal) * 100)}%</Text></Text>
                  ))}
                </Box>
              </Box>
            )}
            {all.length > 1 && (
              <Box gap={1}>
                <Text dimColor>activity, last 30 min</Text>
                <Text color={tone}>{spark(all, now, 30)}</Text>
              </Box>
            )}
          </Box>
        )}

        <Box gap={1} flexWrap="wrap">
          {tab('All', 'all')}
          {isAgy ? tab('Turns', 'turns') : tab('Tools', 'tools')}
          {isAgy ? tab('Edits', 'tools') : tab('Thoughts', 'say')}
          <Button key="older" onPress={() => update($, scroll, () => Math.max(Math.min(rows, shown.length), end - step))}>↑</Button>
          <Button key="newer" onPress={() => update($, scroll, () => (isLive || end + step >= shown.length ? 0 : end + step))}>↓</Button>
          <Button key="live" variant={isLive ? 'primary' : 'secondary'} onPress={() => update($, scroll, () => 0)}>
            {isLive ? '● Live' : shown.length > end ? `Jump to live (+${shown.length - end})` : 'Jump to live'}
          </Button>
          <Box gap={1}>
            <Button key="rows-less" onPress={() => setRows(timelineRows - ROWS_STEP)}>−</Button>
            <Text dimColor>{timelineRows > 0 ? `${timelineRows} rows` : 'auto rows'}</Text>
            <Button key="rows-more" onPress={() => setRows(timelineRows + ROWS_STEP)}>+</Button>
          </Box>
        </Box>

        <Box flexDirection="column">
          <Box marginBottom={1}>
          <Text bold dimColor>
            TIMELINE{shown.length === 0 ? '  ·  no events yet' : `  ·  ${Math.max(1, end - view.length + 1)}–${end} of ${shown.length}`}
          </Text>
          </Box>
          {view.map((x, i) => {
            const isPath = x.kind === 'tool' || x.kind === 'file'
            const { dir, name } = isPath ? splitPath(x.text) : { dir: '', name: x.text }
            const color = x.kind === 'err' ? 'red' : tintOf(x.tag)
            const isProse = x.kind === 'say' || x.kind === 'think' || x.kind === 'turn'
            const id = idOf(x)
            const isOpen = open.has(id)
            const isLong = isProse && (x.text.length > 90 || x.text.includes('\n'))
            return (
              <Box key={`e${i}`} gap={1} marginTop={i === 0 ? 0 : 0}>
                <Box width={e.surface === 'terminal' ? 18 : 13} flexShrink={0}>
                  <Text dimColor>{x.t > 0 ? clock(x.t) : '--:--:--'}{' '}</Text>
                  <Text color={color}>({run && x.t > 0 ? rel(x.t - run.startedAt) : '--:--'})</Text>
                </Box>
                <Text color={color} bold>▌</Text>
                <Box width={10} flexShrink={0}>
                  <Text color={color} bold>{glyph(x.kind)} </Text>
                  <Text bold inverse color={color}>{` ${x.tag.toUpperCase().slice(0, 6).padEnd(6)} `}</Text>
                </Box>
                <Box width={3} flexShrink={0}>
                  {isLong ? <Button key={`x${i}`} onPress={() => flip(id)}>{isOpen ? '▾' : '▸'}</Button> : null}
                </Box>
                <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text wrap={isProse && (isOpen || !isLong) ? 'wrap' : 'truncate-end'} bold={isPath} italic={x.kind === 'think'} dimColor={isProse} color={x.kind === 'err' ? 'red' : undefined}>
                    {isOpen && timelineRows === 0 ? fitText(name, expandCap(budget), textCols) : name}
                  </Text>
                  {dir ? <Text dimColor wrap="truncate-middle">{dir}</Text> : null}
                </Box>
              </Box>
            )
          })}
        </Box>
      </Box>
    )
  })
}
