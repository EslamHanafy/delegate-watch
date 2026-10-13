import type { Ev, Run } from '../types'

const WIDTH = 200
export const MAX_EVENTS = 4000

const clip = (text: string): string => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > WIDTH ? `${one.slice(0, WIDTH - 1)}…` : one
}

const detailOf = (input: unknown): string => {
  if (typeof input !== 'object' || input === null) return ''
  const o = input as Record<string, any>
  const pick = o.filePath ?? o.path ?? o.file_path ?? o.command ?? o.pattern ?? o.query ?? o.description ?? o.taskId
  return typeof pick === 'string' ? pick : ''
}

export type Totals = { tools: number; cost: number; turns: number; lastTurn: number; think: string }

const shorten = (p: string): string => {
  const rel = p.replace(/^\/Users\/[^/]+\/(?:[^/]+\/)*?(?=(?:lib|test|src|backend|frontend|docs|app|packages|assets|scripts|tests)\/)/, '')
  if (rel !== p) return rel
  const parts = p.split('/')
  return parts.length > 4 ? `…/${parts.slice(-3).join('/')}` : p
}

const firstLine = (text: string): string => clip((text.split('\n')[0] ?? '').trim())

export const parseLines = (lines: string[], out: Ev[], totals: Totals): void => {
  for (const raw of lines) {
    if (!raw.startsWith('{')) continue
    let ev: any
    try {
      ev = JSON.parse(raw)
    } catch {
      continue
    }
    const t = Number(ev.timestamp_ms ?? ev.timestamp ?? 0)
    if (ev.type === 'step_finish' && typeof ev.part?.cost === 'number') {
      totals.cost += ev.part.cost
    } else if (ev.type === 'tool_use' && ev.part) {
      const st = ev.part.state
      const detail = detailOf(st?.input)
      if (st?.status === 'error') {
        out.push({ t, kind: 'err', tag: String(ev.part.tool), text: clip(`${shorten(detail)} ${String(st.error ?? '')}`) })
      } else if (st?.status === 'completed') {
        totals.tools += 1
        out.push({ t, kind: 'tool', tag: String(ev.part.tool), text: shorten(firstLine(detail)) })
      }
    } else if (ev.type === 'text' && typeof ev.part?.text === 'string' && ev.part.text.trim()) {
      out.push({ t, kind: 'say', tag: 'say', text: clip(ev.part.text) })
    } else if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      const text = ev.message.content.find((p: any) => p?.type === 'text')?.text
      if (typeof text === 'string' && text.trim()) out.push({ t, kind: 'say', tag: 'say', text: clip(text) })
    } else if (ev.type === 'thinking') {
      if (ev.subtype === 'delta' && typeof ev.text === 'string') totals.think += ev.text
      if (ev.subtype === 'completed') {
        if (totals.think.trim()) out.push({ t, kind: 'think', tag: 'think', text: clip(totals.think) })
        totals.think = ''
      }
    } else if (ev.type === 'tool_call' && ev.subtype === 'started' && ev.tool_call) {
      const key = Object.keys(ev.tool_call)[0] ?? 'tool'
      const args = ev.tool_call[key]?.args
      const detail = detailOf(args) || (typeof args?.description === 'string' ? args.description : '')
      totals.tools += 1
      out.push({ t, kind: 'tool', tag: key.replace(/ToolCall$/, ''), text: shorten(firstLine(detail)) })
    }
  }
}

export const agentOf = (names: string[], head: string): Run['agent'] => {
  if (names.includes('agy.log')) return 'agy'
  if (head.includes('"session_id"')) return 'cursor'
  if (head.includes('"sessionID"')) return 'opencode'
  return 'unknown'
}

const START = /-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/

export const startOf = (name: string): number | null => {
  const m = START.exec(name)
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : null
}

export const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export const clock = (ms: number): string => (ms > 0 ? new Date(ms).toTimeString().slice(0, 8) : '        ')

export type Snap = Map<string, string>

// `mtime path` lines (seconds since the epoch) of the files git reports modified or untracked
export const parseStat = (out: string): Snap => {
  const snap: Snap = new Map()
  for (const l of out.split('\n')) {
    const sp = l.indexOf(' ')
    if (sp > 0) snap.set(l.slice(sp + 1), l.slice(0, sp))
  }
  return snap
}

export const editsSince = (prev: Snap | null, next: Snap, since: number, root: string): Ev[] => {
  const out: Ev[] = []
  for (const [p, m] of next) {
    const t = Number(m) * 1000
    if (t >= since && prev?.get(p) !== m) out.push({ t, kind: 'file', tag: 'edit', text: p.startsWith(root) ? p.slice(root.length + 1) : p })
  }
  return out.sort((a, b) => a.t - b.t)
}

const GLOG = /^[IWEF](\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})/

// agy's own log: each model turn is one streamGenerateContent request
export const parseAgyLines = (lines: string[], out: Ev[], totals: Totals, year: number): void => {
  for (const l of lines) {
    if (!l.includes('streamGenerateContent')) continue
    const m = GLOG.exec(l)
    if (!m) continue
    const t = new Date(year, Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime()
    totals.turns += 1
    totals.lastTurn = t
    out.push({ t, kind: 'turn', tag: 'turn', text: `model turn ${totals.turns}` })
  }
}

const WAITING = /(idle; waiting.*|waiting up to.*background task.*)$/

export const blockedOf = (stderr: string): string => {
  const lines = stderr.split('\n').filter(l => l.trim())
  const last = lines[lines.length - 1] ?? ''
  const m = WAITING.exec(last)
  return m ? clip(m[1] ?? '') : ''
}

// the commands running beneath the agy process, from `pgrep` pids and a `ps` listing
export const childrenOf = (out: string): string[] => {
  const [pidPart = '', psPart = ''] = out.split('@@\n')
  const roots = new Set(pidPart.split('\n').map(x => x.trim()).filter(Boolean))
  const rows = psPart.split('\n').map(l => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l)).filter((m): m is RegExpExecArray => m !== null)
  const keep = new Set(roots)
  for (let grew = true; grew; ) {
    grew = false
    for (const m of rows) {
      if (keep.has(m[2]!) && !keep.has(m[1]!)) {
        keep.add(m[1]!)
        grew = true
      }
    }
  }
  return rows
    .filter(m => keep.has(m[1]!) && !roots.has(m[1]!) && !/^(ps|sh|pgrep)\b/.test(m[4]!))
    .map(m => `${m[3]}  ${clip(m[4]!).slice(0, 90)}`)
    .slice(0, 6)
}

const BARS = '▁▂▃▄▅▆▇█'

// events per minute over the last `minutes`, as block characters
export const spark = (evs: Ev[], now: number, minutes: number): string => {
  const b = new Array<number>(minutes).fill(0)
  for (const e of evs) {
    const i = minutes - 1 - Math.floor((now - e.t) / 60000)
    if (e.t > 0 && i >= 0 && i < minutes) b[i]! += 1
  }
  const max = Math.max(1, ...b)
  return b.map(n => (n === 0 ? '·' : BARS[Math.min(7, Math.ceil((n / max) * 7))]!)).join('')
}

export const rel = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const mm = String(Math.floor(s / 60) % 60).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${mm}:${ss}`
}

export const glyph = (kind: string): string => ({ tool: '▸', file: '✎', turn: '◆', say: '”', think: '✦', err: '✗' })[kind] ?? '·'

export const splitPath = (text: string): { dir: string; name: string } => {
  const cut = text.lastIndexOf('/')
  return cut > 0 ? { dir: text.slice(0, cut + 1), name: text.slice(cut + 1) } : { dir: '', name: text }
}

export const mixOf = (evs: Ev[]): [string, number][] => {
  const c = new Map<string, number>()
  for (const e of evs) if (e.kind === 'tool' || e.kind === 'file' || e.kind === 'turn') c.set(e.tag, (c.get(e.tag) ?? 0) + 1)
  return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
}

const TINT: Record<string, string> = {
  read: 'cyan', grep: '#60a5fa', glob: '#60a5fa', ls: '#60a5fa', edit: 'yellow', write: 'yellow', patch: 'yellow', apply_patch: 'yellow',
  shell: '#fb923c', bash: '#fb923c', turn: '#60a5fa', think: 'gray', say: 'green', await: 'gray',
}
export const tintOf = (tag: string): string => TINT[tag.toLowerCase()] ?? 'white'
