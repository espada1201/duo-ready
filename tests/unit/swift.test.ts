import { describe, expect, it } from 'vitest';
import { hunks, unifiedDiff } from '../../src/core/diff';
import { maskSwift, parseSwift, walk } from '../../src/core/swift';
import { position } from '../../src/core/text';

describe('maskSwift', () => {
  it('blanks comments and string bodies but keeps offsets and newlines', () => {
    const src = 'let a = "UIScreen.main" // UIScreen.main\n/* UIScreen.main /* nested */ */ UIScreen.main';
    const masked = maskSwift(src);
    expect(masked).toHaveLength(src.length);
    expect(masked.split('\n')).toHaveLength(2);
    expect(masked.match(/UIScreen\.main/g)).toHaveLength(1);
    expect(masked.indexOf('UIScreen.main')).toBe(src.lastIndexOf('UIScreen.main'));
  });

  it('keeps code inside string interpolation visible', () => {
    const masked = maskSwift('let s = "scale \\(UIScreen.main.scale) done"');
    expect(masked).toContain('UIScreen.main.scale');
    expect(masked).not.toContain('done');
  });

  it('handles raw and multiline strings', () => {
    const masked = maskSwift('let r = #"a "UIScreen.main" b"#\nlet m = """\nUIScreen.main\n"""\nUIScreen.main');
    expect(masked.match(/UIScreen\.main/g)).toHaveLength(1);
  });

  it('does not let an unterminated string swallow the next line', () => {
    const masked = maskSwift('let s = "oops\nUIScreen.main');
    expect(masked).toContain('UIScreen.main');
  });
});

describe('parseSwift', () => {
  it('labels closures with their owning call, including labelled trailing closures', () => {
    const src = 'ScrollView(.vertical) {\n  ArrangementView {\n    A()\n  } secondary: {\n    NavigationStack { B() }\n  }\n}';
    const blocks = [...walk(parseSwift(src).root)];
    expect(blocks.map((b) => [b.label, b.argument])).toEqual([
      ['ScrollView', null],
      ['ArrangementView', null],
      ['ArrangementView', 'secondary'],
      ['NavigationStack', null],
    ]);
    const nav = blocks[3];
    expect(nav.parent?.argument).toBe('secondary');
  });

  it('ignores braces in strings and comments', () => {
    const blocks = [...walk(parseSwift('VStack { Text("}{") // }\n }').root)];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].label).toBe('VStack');
  });

  it('maps offsets to 1-based lines and columns', () => {
    const src = parseSwift('a\nbc\ndef');
    expect(position(src.lineStarts, 0)).toEqual({ line: 1, column: 1 });
    expect(position(src.lineStarts, 3)).toEqual({ line: 2, column: 2 });
    expect(position(src.lineStarts, 7)).toEqual({ line: 3, column: 3 });
  });
});

describe('diff', () => {
  it('shows exactly the lines each edit touches, with indentation, even when lines repeat', () => {
    const content = 'I.resizable()\n    I.resizable()\nc';
    expect(hunks(content, [{ start: 13, end: 13, text: '.scaledToFit()' }])).toEqual([
      { line: 1, removed: ['I.resizable()'], added: ['I.resizable().scaledToFit()'] },
    ]);
    expect(hunks(content, [{ start: 31, end: 31, text: '\n    .x()' }, { start: 0, end: 1, text: 'J' }])).toEqual([
      { line: 1, removed: ['I.resizable()'], added: ['J.resizable()'] },
      { line: 2, removed: ['    I.resizable()'], added: ['    I.resizable()', '    .x()'] },
    ]);
  });
});

describe('unifiedDiff', () => {
  it('shifts later hunks by the lines earlier ones added, and merges hunks whose context touches', () => {
    const content = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n') + '\n';
    const at = (line: number) => content.indexOf(`l${line}\n`);
    const far = unifiedDiff('a.swift', content, [
      { start: at(2), end: at(2), text: 'new\n' },
      { start: at(15), end: at(15) + 3, text: 'L15' },
    ]);
    expect(far.split('\n').filter((l) => l.startsWith('@@'))).toEqual(['@@ -1,5 +1,6 @@', '@@ -12,7 +13,7 @@']);
    const near = unifiedDiff('a.swift', content, [
      { start: at(2), end: at(2) + 2, text: 'L2' },
      { start: at(8), end: at(8) + 2, text: 'L8' },
    ]);
    expect(near.split('\n').filter((l) => l.startsWith('@@'))).toEqual(['@@ -1,11 +1,11 @@']);
  });
});
