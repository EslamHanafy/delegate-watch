export type Ev = {
  t: number
  kind: 'tool' | 'say' | 'think' | 'err' | 'file' | 'turn'
  tag: string
  text: string
}

export type Run = {
  dir: string
  name: string
  agent: 'agy' | 'cursor' | 'opencode' | 'unknown'
  model: string
  startedAt: number
  finishedAt: number
  updatedAt: number
  status: string
  isDone: boolean
  touched: number | null
  tools: number
  cost: number
  note: string
  turns: number
  lastTurn: number
  blocked: string
  procs: { age: string; cmd: string; isHelper: boolean }[]
}

// the poll loop's pulse: when it last completed, how often it has run, and the last failure
export type Beat = {
  okAt: number
  ticks: number
  errors: number
  error: string
  errorAt: number
}

export type Filter = 'all' | 'tools' | 'say' | 'turns'

declare module 'claude-code' {
  interface PluginState {
    'delegate-watch': {
      runs: Run[]
      selected: string | null
      events: Ev[]
      scroll: number
      paused: boolean
      filter: Filter
      rowsPref: number
      expanded: string[]
      beat: Beat
    }
  }
}
