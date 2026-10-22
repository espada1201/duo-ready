import { describe, expect, it } from 'vitest';
import { hunks } from '../../src/core/diff';
import { maskSwift, parseSwift, position, walk } from '../../src/core/swift';

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
    expect(position(src, 0)).toEqual({ line: 1, column: 1 });
    expect(position(src, 3)).toEqual({ line: 2, column: 2 });
    expect(position(src, 7)).toEqual({ line: 3, column: 3 });
  });
});

describe('diff', () => {
  it('keeps indentation and reports each changed hunk with its line', () => {
    expect(hunks('a\n    b\nc\nd', 'a\n    B\nc\nd\n    e')).toEqual([
      { line: 2, removed: ['    b'], added: ['    B'] },
      { line: 5, removed: [], added: ['    e'] },
    ]);
  });
});
