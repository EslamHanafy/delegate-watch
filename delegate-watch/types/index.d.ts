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

export type Filter = 'all' | 'tools' | 'say' | 'turns'

declare module 'claude-code' {
  interface PluginState {
    'delegate-watch': {
      runs: Run[]
      selected: string | null
      events: Ev[]
      scroll: number
      filter: Filter
    }
  }
}
