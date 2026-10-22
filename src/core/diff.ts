// Diffs for fixes, built from the fixes' own edits so a hunk is exactly the lines an edit touches.

import { lineStarts, position } from './text';
import type { Edit } from './types';

export interface Hunk {
  /** 1-based line in the original where the hunk starts. */
  line: number;
  removed: string[];
  added: string[];
}

/** Hunks for non-overlapping `edits` to `content`. Edits on the same line share a hunk. */
export function hunks(content: string, edits: Edit[]): Hunk[] {
  const starts = lineStarts(content);
  const lines = content.split('\n');
  const groups: { first: number; last: number; edits: Edit[] }[] = [];
  for (const e of [...edits].sort((a, b) => a.start - b.start)) {
    const first = position(starts, e.start).line - 1;
    const last = position(starts, e.end).line - 1;
    const prev = groups[groups.length - 1];
    if (prev && first <= prev.last) {
      prev.last = Math.max(prev.last, last);
      prev.edits.push(e);
    } else groups.push({ first, last, edits: [e] });
  }
  return groups.map(({ first, last, edits: group }) => {
    const from = starts[first];
    let text = lines.slice(first, last + 1).join('\n');
    for (const e of [...group].reverse()) text = text.slice(0, e.start - from) + e.text + text.slice(e.end - from);
    return { line: first + 1, removed: lines.slice(first, last + 1), added: text.split('\n') };
  });
}

export function unifiedDiff(path: string, content: string, edits: Edit[]): string {
  if (!edits.length) return '';
  const lines = [`--- ${path}`, `+++ ${path}`];
  for (const h of hunks(content, edits)) lines.push(`@@ line ${h.line} @@`, ...h.removed.map((l) => `-${l}`), ...h.added.map((l) => `+${l}`));
  return lines.join('\n');
}
