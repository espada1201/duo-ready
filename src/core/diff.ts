// Diffs for fixes, built from the fixes' own edits so a hunk is exactly the lines an edit touches.

import { fixLabel } from './findings';
import { lineStarts, position } from './text';
import type { Edit, Finding, SourceFile } from './types';

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

const CONTEXT = 3;
const NO_NEWLINE = '\\ No newline at end of file';

const range = (start: number, length: number) => (length === 1 ? `${start}` : `${length ? start : start - 1},${length}`);

/**
 * A unified diff with three lines of context that `git apply` and `patch -p1` accept.
 * `notes` go above the file header, where both tools ignore them.
 */
export function unifiedDiff(path: string, content: string, edits: Edit[], notes: string[] = []): string {
  if (!edits.length) return '';
  const lines = content.split('\n');
  const newlineAtEnd = content.endsWith('\n');
  if (newlineAtEnd) lines.pop();
  const out = [...notes, `--- a/${path}`, `+++ b/${path}`];
  // Hunks whose context would touch merge into one, as diff does.
  const groups: Hunk[][] = [];
  for (const h of hunks(content, edits)) {
    const prev = groups[groups.length - 1]?.at(-1);
    if (prev && h.line - (prev.line + prev.removed.length) <= 2 * CONTEXT) groups[groups.length - 1].push(h);
    else groups.push([h]);
  }
  let shift = 0;
  for (const group of groups) {
    const last = group[group.length - 1];
    const from = Math.max(0, group[0].line - 1 - CONTEXT);
    const to = Math.min(lines.length, last.line - 1 + last.removed.length + CONTEXT);
    const body: string[] = [];
    let at = from;
    let added = 0;
    for (const h of group) {
      body.push(...lines.slice(at, h.line - 1).map((l) => ` ${l}`), ...h.removed.map((l) => `-${l}`));
      // The file's last line has no newline: say so after it on each side it appears.
      if (!newlineAtEnd && h.line - 1 + h.removed.length === lines.length) body.push(NO_NEWLINE);
      body.push(...h.added.map((l) => `+${l}`));
      if (!newlineAtEnd && h.line - 1 + h.removed.length === lines.length) body.push(NO_NEWLINE);
      added += h.added.length - h.removed.length;
      at = h.line - 1 + h.removed.length;
    }
    body.push(...lines.slice(at, to).map((l) => ` ${l}`));
    if (!newlineAtEnd && at < to && to === lines.length) body.push(NO_NEWLINE);
    out.push(`@@ -${range(from + 1, to - from)} +${range(from + 1 + shift, to - from + added)} @@`, ...body);
    shift += added;
  }
  return out.join('\n');
}

/** One patch for the `applied` fixes across `files`, with each fix described above its file. */
export function patchFor(files: SourceFile[], applied: Finding[]): string {
  return files
    .map((file) => {
      const mine = applied.filter((f) => f.path === file.path);
      const notes = mine.map((f) => `# ${file.path}:${f.line} ${f.fix!.description}${fixLabel(f)}`);
      return unifiedDiff(file.path, file.content, mine.flatMap((f) => f.fix!.edits), notes);
    })
    .filter(Boolean)
    .join('\n');
}
