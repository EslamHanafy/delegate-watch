import { test, expect } from 'claude-code/testing'
import { anchorsOf, mergeCands, resolveRoots, searchedHint } from './roots'

const WATCH = ['$TMPDIR/delegate-relay', '.orchestrator', '.superpowers']

test('a relative watch path still finds the repo folder after the cwd moved into a subfolder', () => {
  const repo = '/Users/me/proj'
  const moved = `${repo}/.superpowers/sdd/runs/p2-6`
  const roots = resolveRoots(WATCH, anchorsOf(repo, moved, repo), '/tmp/x/', '/Users/me')
  expect(roots).toContain(`${repo}/.superpowers`)
  expect(roots[0]).toBe('/tmp/x/delegate-relay')
})

test('the start cwd is an anchor even outside a git work tree', () => {
  const anchors = anchorsOf('/a/proj', '/a/proj/backend/src', null)
  expect(anchors).toEqual(['/a/proj', '/a/proj/backend/src'])
  expect(resolveRoots(['.superpowers'], anchors, '/tmp', '/h')).toEqual(['/a/proj/.superpowers', '/a/proj/backend/src/.superpowers'])
})

test('anchors and roots carry no duplicates, absolute and ~ paths are kept once', () => {
  expect(anchorsOf('/p/', '/p', '/p')).toEqual(['/p'])
  expect(resolveRoots(['~/runs', '/abs', '/abs/', './rel'], ['/p', '/q'], '/tmp', '/h')).toEqual(['/h/runs', '/abs', '/p/rel', '/q/rel'])
})

test('a run missed by one search stays until it is gone or too old', () => {
  const live = { dir: '/p/.superpowers/runs/a', name: 'a', mtime: 1000 }
  const old = { dir: '/p/.superpowers/runs/b', name: 'b', mtime: 10 }
  const fresh = { dir: '/p/.orchestrator/c', name: 'c', mtime: 500 }
  expect(mergeCands([live, old], [fresh], new Set(), 100).map(c => c.name)).toEqual(['a', 'c'])
  expect(mergeCands([live], [fresh], new Set([live.dir]), 0).map(c => c.name)).toEqual(['c'])
  expect(mergeCands([live], [{ ...live, mtime: 2000 }], new Set(), 0)).toEqual([{ ...live, mtime: 2000 }])
})

test('the empty pane names the folders it searched', () => {
  expect(searchedHint([])).toBeNull()
  expect(searchedHint(['/p/.superpowers', '/tmp/delegate-relay'])).toBe('Searched: /p/.superpowers, /tmp/delegate-relay')
})
