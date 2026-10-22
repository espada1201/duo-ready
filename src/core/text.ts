/** "a", "a and b", "a, b and c". */
export function joinEnglish(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : (items[0] ?? '');
}

/** Groups items by key, keeping first-seen key order. */
export function groupBy<T, K>(items: Iterable<T>, key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

/** The line holding `offset`; on a very long (minified) line, the 1,000 characters either side. */
export function lineAround(text: string, offset: number): string {
  // Searching a bounded window keeps many hits on one huge line linear.
  const from = Math.max(0, offset - 1000);
  const before = text.slice(from, offset).lastIndexOf('\n');
  const after = text.slice(offset, offset + 1000);
  const end = after.indexOf('\n');
  return text.slice(before < 0 ? from : from + before + 1, offset) + (end < 0 ? after : after.slice(0, end)).replace(/\r$/, '');
}

export function lineIndent(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start, start + 200))![0];
}

export const eolOf = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n');

/** Offset where each line begins. */
export function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') out.push(i + 1);
  return out;
}

/** 1-based line and column of `offset`, given the text's `lineStarts`. */
export function position(starts: number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo] + 1 };
}
