import { test, expect } from 'claude-code/testing'
import { blockedOf, childrenOf, parseAgyLines, parseLines, parseStat, editsSince } from './summarize'

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
