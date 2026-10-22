// Objective-C and Objective-C++ read with the same block tree as Swift, but masked by C's rules:
// `@"…"` and `"…"` strings, `'c'` characters, C++ raw strings, comments and `#if 0` regions.

import { type SwiftSource, withBlocks } from './swift';

const UTF16 = new TextDecoder('utf-16le');

function maskC(text: string): { masked: string; strings: Uint8Array } {
  const out = new Uint16Array(text.length);
  for (let k = 0; k < text.length; k++) out[k] = text.charCodeAt(k);
  const strings = new Uint8Array(text.length);
  const blank = (from: number, to: number, isString = false) => {
    for (let m = from; m < to; m++) {
      if (out[m] !== 10) out[m] = 32;
      if (isString) strings[m] = 1;
    }
  };
  const n = text.length;
  // A quoted run from `i`, which holds the quote; returns where it ends. Strings stop at a line end.
  const quoted = (i: number, quote: string) => {
    let j = i + 1;
    while (j < n && text[j] !== quote && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
    return Math.min(j, n);
  };
  let lineStart = true;
  for (let i = 0; i < n; ) {
    const c = text[i];
    if (c === '\n') {
      lineStart = true;
      i++;
      continue;
    }
    if (lineStart && c === '#') {
      const directive = /^#\s*if\s+0\b/.exec(text.slice(i, i + 12));
      if (directive) {
        // Up to the matching #else, #elif or #endif, counting nested #if.
        const re = /^[ \t]*#\s*(if|ifdef|ifndef|else|elif|endif)\b/gm;
        re.lastIndex = text.indexOf('\n', i) + 1 || n;
        let depth = 0;
        let end = n;
        for (let m = re.exec(text); m; m = re.exec(text)) {
          if (m[1].startsWith('if')) depth++;
          else if (depth) depth -= m[1] === 'endif' ? 1 : 0;
          else {
            end = m.index;
            break;
          }
        }
        const from = text.indexOf('\n', i) + 1 || n;
        blank(from, end);
        i = end;
        continue;
      }
    }
    if (c !== ' ' && c !== '\t') lineStart = false;
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      blank(i, end < 0 ? n : end);
      i = end < 0 ? n : end;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const to = end < 0 ? n : end + 2;
      blank(i, to);
      i = to;
    } else if (c === 'R' && text[i + 1] === '"' && !/[\w]/.test(text[i - 1] ?? '')) {
      const open = /^R"([^\s()\\]{0,16})\(/.exec(text.slice(i, i + 20));
      if (!open) {
        i++;
        continue;
      }
      const close = text.indexOf(`)${open[1]}"`, i + open[0].length);
      const to = close < 0 ? n : close;
      blank(i + open[0].length, to, true);
      i = close < 0 ? n : close + open[1].length + 2;
    } else if (c === '"' || c === "'") {
      const end = quoted(i, c);
      blank(i + 1, end, c === '"');
      i = end + 1;
    } else i++;
  }
  return { masked: UTF16.decode(out), strings };
}

export function parseObjC(text: string): SwiftSource {
  return withBlocks(text, maskC(text));
}
