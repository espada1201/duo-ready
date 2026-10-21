// Minimal XML property list reader. Binary plists return null.

export type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

interface PlistKey {
  value: PlistValue;
  /** Offset of the `<key>` element, for line reporting. */
  offset: number;
}

const TOKEN = /<(\/?)(dict|array|key|string|integer|real|true|false|date|data)(\s*\/)?>|<\?[^>]*\?>|<!DOCTYPE[^>]*>|<\/?plist[^>]*>|<!--[\s\S]*?-->/g;

export function parsePlist(xml: string): { root: PlistValue; keys: Map<string, PlistKey> } | null {
  if (!xml.includes('<plist')) return null;
  const tokens: { close: boolean; tag: string; selfClosing: boolean; start: number; end: number }[] = [];
  for (const m of xml.matchAll(TOKEN)) {
    if (!m[2]) continue;
    tokens.push({ close: m[1] === '/', tag: m[2], selfClosing: !!m[3], start: m.index!, end: m.index! + m[0].length });
  }
  let i = 0;
  const keys = new Map<string, PlistKey>();
  const decode = (s: string) =>
    s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

  const text = (open: (typeof tokens)[number]): string => {
    if (open.selfClosing) return '';
    const close = tokens[i++];
    if (!close || !close.close || close.tag !== open.tag) throw new Error(`Unclosed <${open.tag}>`);
    return decode(xml.slice(open.end, close.start));
  };

  const value = (depth: number): PlistValue => {
    const t = tokens[i++];
    if (!t || t.close) throw new Error('Unexpected end of plist');
    switch (t.tag) {
      case 'true':
      case 'false':
        if (!t.selfClosing) i++;
        return t.tag === 'true';
      case 'integer':
      case 'real':
        return Number(text(t));
      case 'string':
      case 'date':
      case 'data':
        return text(t);
      case 'array': {
        const out: PlistValue[] = [];
        if (t.selfClosing) return out;
        while (tokens[i] && !(tokens[i].close && tokens[i].tag === 'array')) out.push(value(depth + 1));
        i++;
        return out;
      }
      case 'dict': {
        const out: { [key: string]: PlistValue } = {};
        if (t.selfClosing) return out;
        while (tokens[i] && !(tokens[i].close && tokens[i].tag === 'dict')) {
          const k = tokens[i++];
          if (k.tag !== 'key') throw new Error('Expected <key>');
          const name = text(k);
          out[name] = value(depth + 1);
          if (depth === 0) keys.set(name, { value: out[name], offset: k.start });
        }
        i++;
        return out;
      }
      default:
        throw new Error(`Unexpected <${t.tag}>`);
    }
  };

  try {
    return { root: value(0), keys };
  } catch {
    return null;
  }
}
