// Line diff for fixes. Fixes never reorder lines, so walking both sides and resyncing
// within a short lookahead isolates each changed hunk.

export interface Hunk {
  /** 1-based line in the original where the hunk starts. */
  line: number;
  removed: string[];
  added: string[];
}

export function hunks(before: string, after: string): Hunk[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const out: Hunk[] = [];
  let ai = 0;
  let bi = 0;
  const resync = () => {
    for (let look = 0; look < 5; look++) if (a[ai] !== undefined && a[ai] === b[bi + look]) return look;
    return -1;
  };
  while (ai < a.length || bi < b.length) {
    if (a[ai] === b[bi]) {
      ai++;
      bi++;
      continue;
    }
    const hunk: Hunk = { line: ai + 1, removed: [], added: [] };
    let skip = resync();
    while (skip !== 0 && (ai < a.length || bi < b.length)) {
      if (skip > 0) {
        hunk.added.push(...b.slice(bi, bi + skip));
        bi += skip;
        break;
      }
      if (ai < a.length) hunk.removed.push(a[ai++]);
      if (bi < b.length) hunk.added.push(b[bi++]);
      skip = resync();
    }
    out.push(hunk);
  }
  return out;
}

export function unifiedDiff(path: string, before: string, after: string): string {
  if (before === after) return '';
  const lines = [`--- ${path}`, `+++ ${path}`];
  for (const h of hunks(before, after)) lines.push(`@@ line ${h.line} @@`, ...h.removed.map((l) => `-${l}`), ...h.added.map((l) => `+${l}`));
  return lines.join('\n');
}
