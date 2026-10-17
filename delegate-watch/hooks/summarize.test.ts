import { test, expect } from 'claude-code/testing'
import { agentOf, blockedOf, childrenOf, expandCap, fitRows, fitText, topLines, weightOf, parseAgyLines, parseLines, parseStat, editsSince } from './summarize'

test('opencode events become tool and say rows', () => {
  const out: any[] = []
  const totals = { tools: 0, cost: 0, turns: 0, lastTurn: 0, think: '' }
  parseLines(
    [
      '{"type":"text","timestamp":5,"part":{"text":"hello"}}',
      '{"type":"tool_use","timestamp":6,"part":{"tool":"read","state":{"status":"completed","input":{"path":"/a/b.cs"}}}}',
      '{"type":"step_finish","part":{"cost":0.5}}',
      'not json',
    ],
    out,
    totals,
  )
  expect(out.map(x => x.kind)).toEqual(['say', 'tool'])
  expect(`${out[1].tag} ${out[1].text}`).toBe('read /a/b.cs')
  expect(totals).toEqual({ tools: 1, cost: 0.5, turns: 0, lastTurn: 0, think: '' })
})

test('file edits are those touched since the run started', () => {
  const next = parseStat('100 old.cs\n200 new.cs\n')
  expect(editsSince(null, next, 150000, '/r').map(x => x.text)).toEqual(['new.cs'])
  expect(editsSince(next, next, 0, '/r')).toEqual([])
})

test('agy turns, blocked line and child processes', () => {
  const out: any[] = []
  const totals = { tools: 0, cost: 0, turns: 0, lastTurn: 0, think: '' }
  parseAgyLines(['I1013 10:42:59.436630 1 h.go:1] URL: x:streamGenerateContent?alt=sse', 'I1013 10:48:28.5 1 h.go:1] URL: loadCodeAssist'], out, totals, 2026)
  expect(totals.turns).toBe(1)
  expect(blockedOf('x\nroot agent idle; waiting up to 3h0m0s for 1 background task(s)\n')).toContain('waiting up to 3h0m0s')
})

test('child processes: wrappers unwrapped, noise dropped, helpers last', () => {
  const ps = [
    '10', '@@',
    ' 10 1 05:00 agy --x',
    ' 11 10 04:00 /bin/bash -c set -euo pipefail; cd /Users/me/proj && flutter test test/a_test.dart',
    ' 12 11 00:10 sleep 5',
    ' 13 10 00:01 (bash)',
    ' 14 10 01:11:20 /Users/me/Flutter/bin/cache/dart-sdk/bin/dart mcp-server',
    ' 15 10 00:02 /bin/bash /var/folders/x/T/run123.sh',
    ' 16 1 01:00 other',
    '',
  ].join('\n')
  const got = childrenOf(ps)
  expect(got.map(x => x.cmd)).toEqual(['flutter test test/a_test.dart', 'script run123.sh', 'dart mcp-server'])
  expect(got.map(x => x.isHelper)).toEqual([false, false, true])
  expect(got[0]!.age).toBe('4m00s')
})

test('cursor stream-json rows become say and tool rows', () => {
  const out: any[] = []
  const totals = { tools: 0, cost: 0, turns: 0, lastTurn: 0, think: '' }
  parseLines(
    [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"on it"}]}}',
      '{"type":"tool_call","subtype":"started","tool_call":{"readToolCall":{"args":{"path":"a.dart"}}}}',
    ],
    out,
    totals,
  )
  expect(out.map(x => `${x.tag}:${x.text}`)).toEqual(['say:on it', 'read:a.dart'])
})

test('real cursor events: thinking is joined, timestamps read', () => {
  const out: any[] = []
  const totals = { tools: 0, cost: 0, turns: 0, lastTurn: 0, think: '' }
  parseLines(
    [
      '{"type":"thinking","subtype":"delta","text":"Looking ","timestamp_ms":1}',
      '{"type":"thinking","subtype":"delta","text":"at it","timestamp_ms":2}',
      '{"type":"thinking","subtype":"completed","timestamp_ms":3}',
      '{"type":"tool_call","subtype":"started","timestamp_ms":4,"tool_call":{"shellToolCall":{"args":{"command":"flutter test\\nmore"}}}}',
    ],
    out,
    totals,
  )
  expect(out.map(x => `${x.tag}:${x.t}:${x.text}`)).toEqual(['think:3:Looking at it', 'shell:4:flutter test'])
})

test('auto rows fill the lines left under the top views and ignore folded prose height', () => {
  const tool = (t: number, text: string): any => ({ t, kind: 'tool', tag: 'read', text })
  const evs: any[] = [
    { t: 0, kind: 'say', tag: 'say', text: 'x'.repeat(500) },
    tool(1, 'lib/a/b.dart'),
    tool(2, 'lib/a/c.dart'),
    tool(3, 'd.dart'),
    tool(4, 'e.dart'),
    tool(5, 'f.dart'),
  ]
  const id = (x: any) => String(x.t)
  expect(fitRows(evs, 6, 6, new Set(), id, 40)).toBe(4)
  expect(fitRows(evs, 6, 100, new Set(), id, 40)).toBe(6)
  expect(fitRows(evs, 6, 100, new Set(['0']), id, 40)).toBe(6)
  expect(fitRows(evs, 6, 5, new Set(['0']), id, 40)).toBe(3)
  expect(fitRows(evs, 6, 1, new Set(), id, 40)).toBe(3)
})

test('top views height grows with the run frame', () => {
  const base = { hasRuns: true, hasRun: false, isDone: true, isAgy: false, hasBlocked: false, activeProcs: 0, helperProcs: 0, hasNote: false, mixTags: 0, hasSpark: false }
  const noRun = topLines(base)
  const withRun = topLines({ ...base, hasRun: true, mixTags: 5, hasSpark: true })
  expect(withRun).toBeGreaterThan(noRun + 10)
  expect(weightOf(4)).toBe(2)
})

test('an expanded message is capped so it cannot push the other rows out', () => {
  const evs: any[] = [
    { t: 0, kind: 'say', tag: 'say', text: 'w'.repeat(1500) },
    ...[1, 2, 3, 4, 5, 6].map(t => ({ t, kind: 'tool', tag: 'read', text: `f${t}.dart` })),
  ]
  const id = (x: any) => String(x.t)
  expect(expandCap(20)).toBe(12)
  expect(fitRows(evs, 7, 20, new Set(['0']), id, 40)).toBe(7)
  expect(fitText('a'.repeat(100), 2, 10).endsWith('…')).toBe(true)
  expect(fitText('short', 2, 10)).toBe('short')
})

test('Claude Code stream-json: detected, tool calls, thoughts, errors and cost', () => {
  expect(agentOf(['events.jsonl'], '{"type":"system","subtype":"hook_started","hook_event":"SessionStart","session_id":"s"}')).toBe('claude')
  expect(agentOf(['events.jsonl'], '{"type":"system","subtype":"init","session_id":"s","model":"m","claude_code_version":"2.1.302"}')).toBe('claude')
  expect(agentOf(['events.jsonl'], '{"type":"system","subtype":"init","session_id":"s","model":"m"}')).toBe('cursor')
  const out: any[] = []
  const totals: any = { tools: 0, cost: 0, turns: 0, lastTurn: 0, think: '' }
  parseLines(
    [
      '{"type":"system","subtype":"thinking_tokens","estimated_tokens":50}',
      '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":""},{"type":"text","text":"reading first"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls tests\\nmore"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"plan it"},{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"/Users/me/p/backend/src/A.cs"}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"},{"type":"tool_result","tool_use_id":"t2","is_error":true,"content":[{"type":"text","text":"File does not exist."}]}]}}',
      '{"type":"result","subtype":"success","total_cost_usd":0.25}',
    ],
    out,
    totals,
    1234,
  )
  expect(out.map(x => `${x.kind}:${x.tag}`)).toEqual(['say:say', 'tool:Bash', 'think:think', 'tool:Read', 'err:Read'])
  expect(out[1].text).toBe('ls tests')
  expect(out[3].text).toBe('backend/src/A.cs')
  expect(out[4].text).toBe('File does not exist.')
  expect(out.every(x => x.t === 1234)).toBe(true)
  expect(totals.tools).toBe(2)
  expect(totals.cost).toBe(0.25)
})
