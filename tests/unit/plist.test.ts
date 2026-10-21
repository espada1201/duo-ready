import { describe, expect, it } from 'vitest';
import { parsePlist } from '../../src/core/plist';

describe('parsePlist', () => {
  it('reads nested XML plists and records top-level key offsets', () => {
    const xml = `<?xml version="1.0"?><plist version="1.0"><dict>
<key>Name</key><string>A &amp; B</string>
<key>Full</key><true/>
<key>Count</key><integer>3</integer>
<key>List</key><array><string>x</string><dict><key>inner</key><false/></dict></array>
<key>Empty</key><array/>
</dict></plist>`;
    const parsed = parsePlist(xml)!;
    expect(parsed.root).toEqual({ Name: 'A & B', Full: true, Count: 3, List: ['x', { inner: false }], Empty: [] });
    expect(parsed.keys.has('inner')).toBe(false);
    expect(xml.slice(parsed.keys.get('Full')!.offset)).toMatch(/^<key>Full/);
  });

  it('returns null for binary or malformed plists', () => {
    expect(parsePlist('bplist00\u0000')).toBeNull();
    expect(parsePlist('<plist><dict><key>a</key></dict></plist>')).toBeNull();
  });
});
