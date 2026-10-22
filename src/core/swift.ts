// A deliberately small Swift reader: enough structure for layout rules, no full parser.
// `masked` keeps every offset of the source but blanks comments and string literal
// contents, so pattern rules never fire on prose or user-facing text.

export interface Block {
  /** Call that owns this closure, e.g. "ScrollView" for `ScrollView(.vertical) {`. */
  label: string | null;
  /** Trailing-closure argument label, e.g. "secondary" for `} secondary: {`. */
  argument: string | null;
  open: number;
  close: number;
  parent: Block | null;
  children: Block[];
}

export interface SwiftSource {
  masked: string;
  root: Block;
  lineStarts: number[];
}

export function maskSwift(text: string): string {
  const out = text.split('');
  const blank = (i: number) => {
    if (out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  const n = text.length;
  // Each entry is the number of `(` still open inside a string interpolation.
  const interp: { hashes: number; multiline: boolean; depth: number }[] = [];

  // Blanks a string body from `from` until its closer or an interpolation `\(`.
  const scanBody = (from: number, hashes: number, multiline: boolean): number => {
    const closer = (multiline ? '"""' : '"') + '#'.repeat(hashes);
    const escape = '\\' + '#'.repeat(hashes);
    let j = from;
    while (j < n) {
      if (text.startsWith(escape, j)) {
        const k = j + escape.length;
        if (text[k] === '(') {
          for (let m = from; m < j; m++) blank(m);
          interp.push({ hashes, multiline, depth: 1 });
          return k + 1;
        }
        j = k + 1;
        continue;
      }
      if (text.startsWith(closer, j)) {
        for (let m = from; m < j; m++) blank(m);
        return j + closer.length;
      }
      if (!multiline && text[j] === '\n') break;
      j++;
    }
    for (let m = from; m < j; m++) blank(m);
    return j;
  };

  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') blank(i++);
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      let depth = 0;
      while (i < n) {
        if (text[i] === '/' && text[i + 1] === '*') {
          depth++;
          blank(i++);
          blank(i++);
        } else if (text[i] === '*' && text[i + 1] === '/') {
          depth--;
          blank(i++);
          blank(i++);
          if (depth === 0) break;
        } else blank(i++);
      }
      continue;
    }
    if (c === '/' && isRegexStart(i)) {
      const end = regexEnd(i);
      if (end > 0) {
        for (let m = i + 1; m < end; m++) blank(m);
        i = end + 1;
        continue;
      }
    }
    const top = interp[interp.length - 1];
    if (top && c === '(') top.depth++;
    if (top && c === ')') {
      top.depth--;
      if (top.depth === 0) {
        interp.pop();
        i = scanBody(i + 1, top.hashes, top.multiline);
        continue;
      }
    }
    if (c === '#' || c === '"') {
      let hashes = 0;
      let j = i;
      while (text[j] === '#') {
        hashes++;
        j++;
      }
      if (text[j] === '"') {
        const multiline = text.startsWith('"""', j);
        i = scanBody(j + (multiline ? 3 : 1), hashes, multiline);
        continue;
      }
    }
    i++;
  }
  return out.join('');

  // `/…/` is a regex literal where an expression starts, never after an operand.
  function isRegexStart(at: number): boolean {
    const next = text[at + 1];
    if (next === undefined || next === ' ' || next === '\t' || next === '\n' || next === '=') return false;
    let j = at - 1;
    while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j--;
    if (j < 0 || '=(,:[{!&|?;\n'.includes(text[j])) return true;
    return /\breturn$/.test(text.slice(Math.max(0, j - 6), j + 1));
  }

  function regexEnd(at: number): number {
    for (let j = at + 1; j < n && text[j] !== '\n'; j++) {
      if (text[j] === '\\') j++;
      else if (text[j] === '/') return j;
    }
    return -1;
  }
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*$/;

function labelBefore(masked: string, brace: number): { label: string | null; argument: string | null } {
  let j = brace - 1;
  while (j >= 0 && /\s/.test(masked[j])) j--;
  // `} secondary: {` — a labelled trailing closure of the previous call.
  if (masked[j] === ':') {
    const m = IDENT.exec(masked.slice(Math.max(0, j - 200), j).trimEnd());
    return { label: null, argument: m ? m[0] : null };
  }
  if (masked[j] === ')') {
    let depth = 0;
    for (; j >= 0; j--) {
      if (masked[j] === ')') depth++;
      else if (masked[j] === '(') {
        depth--;
        if (depth === 0) break;
      }
    }
    j--;
    while (j >= 0 && /\s/.test(masked[j])) j--;
  }
  // Skip generic arguments: `ForEach<Data> {` is rare, but `.init` chains are not worth it.
  const m = IDENT.exec(masked.slice(Math.max(0, j - 80), j + 1));
  return { label: m ? m[0] : null, argument: null };
}

export function parseSwift(text: string): SwiftSource {
  const masked = maskSwift(text);
  const root: Block = { label: null, argument: null, open: -1, close: text.length, parent: null, children: [] };
  let current = root;
  let lastClosed: Block | null = null;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{') {
      let { label, argument } = labelBefore(masked, i);
      if (argument && lastClosed && lastClosed.parent === current && /^\s*[A-Za-z_]\w*\s*:\s*$/.test(masked.slice(lastClosed.close + 1, i))) {
        label = lastClosed.label;
      }
      const block: Block = { label, argument, open: i, close: masked.length, parent: current, children: [] };
      current.children.push(block);
      current = block;
      lastClosed = null;
    } else if (c === '}' && current.parent) {
      current.close = i;
      lastClosed = current;
      current = current.parent;
    }
  }
  return { masked, root, lineStarts: lineStarts(text) };
}

export function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') out.push(i + 1);
  return out;
}

export function position(src: { lineStarts: number[] }, offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = src.lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (src.lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - src.lineStarts[lo] + 1 };
}

export function* walk(block: Block): Generator<Block> {
  for (const child of block.children) {
    yield child;
    yield* walk(child);
  }
}

export function ancestors(block: Block): Block[] {
  const out: Block[] = [];
  for (let b = block.parent; b && b.parent; b = b.parent) out.push(b);
  return out;
}

/** Innermost block containing `offset`. */
export function blockAt(root: Block, offset: number): Block {
  for (const child of root.children) {
    if (offset > child.open && offset < child.close) return blockAt(child, offset);
  }
  return root;
}

/** Offset of the call that owns `block`, e.g. the `N` of `NavigationView {`. */
export function labelOffset(src: SwiftSource, block: Block): number {
  return src.masked.lastIndexOf(block.label ?? '', block.open);
}

/** Text of the statement that opens `block`, back to the previous brace, semicolon or line break. */
export function headerOf(src: SwiftSource, block: Block): string {
  let j = block.open - 1;
  while (j >= 0 && !'{};\n'.includes(src.masked[j])) j--;
  return src.masked.slice(j + 1, block.open).trim();
}

interface DeclaredType {
  name: string;
  /** Offset of the `class` / `struct` / … keyword. */
  start: number;
  inherits: string[];
  block: Block | null;
}

const typeCache = new WeakMap<SwiftSource, DeclaredType[]>();

/** Declared types in the file with their superclass / conformance list. */
export function declaredTypes(src: SwiftSource): DeclaredType[] {
  const cached = typeCache.get(src);
  if (cached) return cached;
  const byOpen = new Map<number, Block>();
  for (const b of walk(src.root)) byOpen.set(b.open, b);
  const re = /\b(?:class|struct|extension|enum|actor)\s+([A-Za-z_][\w.]*)(?:\s*<[^>{]*>)?\s*(?::\s*([^{]+))?\{/g;
  const out: DeclaredType[] = [];
  for (const m of src.masked.matchAll(re)) {
    const inherits = (m[2] ?? '')
      .replace(/\bwhere\b[\s\S]*/, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    out.push({ name: m[1], start: m.index!, inherits, block: byOpen.get(m.index! + m[0].length - 1) ?? null });
  }
  typeCache.set(src, out);
  return out;
}
