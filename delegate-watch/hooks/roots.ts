// Where to look for run folders, and which run folders to keep between searches.
// The session's working directory moves (every `cd` in a Bash call moves it in the desktop app), so a relative
// watch path is resolved against stable anchors, never against the live cwd alone.

export type Cand = { dir: string; name: string; mtime: number }

const trimSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p)

// The folders a relative watch path is resolved against, most stable first, without duplicates:
// the repository root of the current cwd, the cwd the session started in, and the current cwd.
export const anchorsOf = (startCwd: string, cwd: string, gitTop: string | null): string[] => {
  const out: string[] = []
  for (const p of [gitTop, startCwd, cwd]) {
    const v = trimSlash((p ?? '').trim())
    if (v.startsWith('/') && !out.includes(v)) out.push(v)
  }
  return out
}

// Every watch path as an absolute root: `$TMPDIR` and `~` expanded, an absolute path kept once,
// a relative one joined to each anchor. Duplicates are dropped and the order is kept.
export const resolveRoots = (watch: string[], anchors: string[], tmp: string, home: string): string[] => {
  const out: string[] = []
  const add = (p: string) => {
    const v = trimSlash(p)
    if (!out.includes(v)) out.push(v)
  }
  for (const raw of watch) {
    const abs = raw.trim().replace(/^\$TMPDIR/, trimSlash(tmp)).replace(/^~(?=\/|$)/, trimSlash(home))
    if (abs === '') continue
    if (abs.startsWith('/')) add(abs)
    else for (const a of anchors) add(`${a}/${abs.replace(/^\.\//, '')}`)
  }
  return out
}

// The run folders after a search: what the search found, plus every folder found earlier that the search
// missed, that is not known to be gone and whose log was written after `minMtime` (a search from a different
// cwd must not make a live run vanish, but an old run still ages out). Newest first.
export const mergeCands = (prev: Cand[], fresh: Cand[], gone: Set<string>, minMtime: number): Cand[] => {
  const seen = new Set(fresh.map(c => c.dir))
  const kept = prev.filter(c => !seen.has(c.dir) && !gone.has(c.dir) && c.mtime >= minMtime)
  return [...fresh, ...kept].sort((x, y) => y.mtime - x.mtime)
}

// The line under "No delegate runs yet" naming where the last search looked, or null before the first search.
export const searchedHint = (roots: string[]): string | null => (roots.length > 0 ? `Searched: ${roots.join(', ')}` : null)
