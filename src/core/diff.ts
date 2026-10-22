// Diffs for fixes, built from the fixes' own edits so a hunk is exactly the lines an edit touches.

import { fixLabel } from './findings';
import type { Edit, Finding, SourceFile } from './types';

export interface Hunk {
  /** 1-based line in the original where the hunk starts. */
  line: number;
  removed: string[];
  added: string[];
}

/** A hunk whose lines keep their `\n`, so a last line without one can be told apart. */
interface RawHunk {
  first: number;
  removed: string[];
  added: string[];
}

const splitLines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Hunks for non-overlapping `edits` to `content`. Edits on the same line share a hunk. */
function rawHunks(content: string, edits: Edit[]): RawHunk[] {
  const lines = splitLines(content);
  const starts: number[] = [];
  let offset = 0;
  for (const l of lines) {
    starts.push(offset);
    offset += l.length;
  }
  // The line holding `at`; the end of the file belongs to the last line.
  const lineOf = (at: number) => {
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const groups: { first: number; last: number; edits: Edit[] }[] = [];
  for (const e of [...edits].sort((a, b) => a.start - b.start)) {
    const first = lineOf(e.start);
    const last = e.end > e.start ? lineOf(e.end - 1) : first;
    const prev = groups[groups.length - 1];
    if (prev && first <= prev.last) {
      prev.last = Math.max(prev.last, last);
      prev.edits.push(e);
    } else groups.push({ first, last, edits: [e] });
  }
  const out: RawHunk[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const from = starts[g.first] ?? 0;
    let text = '';
    for (;;) {
      text = lines.slice(g.first, g.last + 1).join('');
      for (const e of [...g.edits].reverse()) text = text.slice(0, e.start - from) + e.text + text.slice(e.end - from);
      // An edit that removes a line break joins the next line onto this one, so the hunk takes that line too.
      if (text.endsWith('\n') || g.last >= lines.length - 1) break;
      g.last++;
      if (groups[i + 1]?.first === g.last) {
        const [next] = groups.splice(i + 1, 1);
        g.edits.push(...next.edits);
        g.last = Math.max(g.last, next.last);
      }
    }
    out.push({ first: g.first, removed: lines.slice(g.first, g.last + 1), added: splitLines(text) });
  }
  return out;
}

const bare = (l: string) => (l.endsWith('\n') ? l.slice(0, -1) : l);

/** Hunks for the lab's fix previews: the lines each fix touches, before and after. */
export function hunks(content: string, edits: Edit[]): Hunk[] {
  return rawHunks(content, edits).map((h) => ({ line: h.first + 1, removed: h.removed.map(bare), added: h.added.map(bare) }));
}

const CONTEXT = 3;

const range = (start: number, length: number) => (length === 1 ? `${start}` : `${length ? start : start - 1},${length}`);

/** Diff lines for `lines`, marking the one that has no newline as the diff format requires. */
const mark = (prefix: string, lines: string[]) => lines.flatMap((l) => (l.endsWith('\n') ? [prefix + l.slice(0, -1)] : [prefix + l, '\\ No newline at end of file']));

/**
 * A unified diff with three lines of context that `git apply` and `patch -p1` accept.
 * `notes` go above the file header, where both tools ignore them.
 */
export function unifiedDiff(path: string, content: string, edits: Edit[], notes: string[] = []): string {
  if (!edits.length) return '';
  const lines = splitLines(content);
  const out = [...notes, `--- a/${path}`, `+++ b/${path}`];
  // Hunks whose context would touch merge into one, as diff does.
  const groups: RawHunk[][] = [];
  for (const h of rawHunks(content, edits)) {
    const prev = groups[groups.length - 1]?.at(-1);
    if (prev && h.first - (prev.first + prev.removed.length) <= 2 * CONTEXT) groups[groups.length - 1].push(h);
    else groups.push([h]);
  }
  let shift = 0;
  for (const group of groups) {
    const last = group[group.length - 1];
    const from = Math.max(0, group[0].first - CONTEXT);
    const to = Math.min(lines.length, last.first + last.removed.length + CONTEXT);
    const body: string[] = [];
    let at = from;
    let added = 0;
    for (const h of group) {
      body.push(...mark(' ', lines.slice(at, h.first)), ...mark('-', h.removed), ...mark('+', h.added));
      added += h.added.length - h.removed.length;
      at = h.first + h.removed.length;
    }
    body.push(...mark(' ', lines.slice(at, to)));
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
