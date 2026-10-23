import { describe, expect, it } from 'vitest';
import { sourceName } from '../../src/web/projectFiles';

const file = (webkitRelativePath: string, name = webkitRelativePath.split('/').pop()!) => ({ name, webkitRelativePath }) as File;

describe('sourceName', () => {
  it('is the first folder of the chosen files, which is the folder that was picked', () => {
    expect(sourceName([file('MyApp/MyApp/View.swift'), file('MyApp/Info.plist')])).toBe('MyApp');
  });
  it('falls back to "Chosen folder" when the browser gives no relative paths', () => {
    expect(sourceName([file('', 'View.swift')])).toBe('Chosen folder');
    expect(sourceName([])).toBe('Chosen folder');
  });
});
