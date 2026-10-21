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
  text: string;
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
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*$/;

function labelBefore(masked: string, brace: number): { label: string | null; argument: string | null } {
  let j = brace - 1;
  while (j >= 0 && /\s/.test(masked[j])) j--;
  // `} secondary: {` — a labelled trailing closure of the previous call.
  if (masked[j] === ':') {
    const m = IDENT.exec(masked.slice(0, j).trimEnd());
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
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  return { text, masked, root, lineStarts };
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

/** Declared types in the file with their superclass / conformance list. */
export function declaredTypes(src: SwiftSource): { name: string; inherits: string[]; block: Block | null }[] {
  const re = /\b(?:class|struct|extension|enum|actor)\s+([A-Za-z_][\w.]*)(?:\s*<[^>{]*>)?\s*(?::\s*([^{]+))?\{/g;
  const out: { name: string; inherits: string[]; block: Block | null }[] = [];
  for (const m of src.masked.matchAll(re)) {
    const braceAt = m.index! + m[0].length - 1;
    let block: Block | null = null;
    for (const b of walk(src.root)) if (b.open === braceAt) block = b;
    const inherits = (m[2] ?? '')
      .replace(/\bwhere\b[\s\S]*/, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    out.push({ name: m[1], inherits, block });
  }
  return out;
}
