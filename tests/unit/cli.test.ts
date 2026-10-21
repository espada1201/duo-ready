import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../../src/cli/main';

const capture = (argv: string[]) => {
  const out: string[] = [];
  const code = run(argv, (s) => out.push(s));
  return { code, out: out.join('\n') };
};

describe('duo-ready CLI', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('prints a readable report and exits 1 when errors remain', () => {
    const { code, out } = capture(['sample', '--no-color']);
    expect(code).toBe(1);
    expect(out).toContain('Encore/Encore/NowPlayingView.swift');
    expect(out).toMatch(/Duo readiness \d+\/100 {2}Not ready/);
    expect(out).toContain('2 safe fixes (--fix), 2 more for review (--fix=all).');
  });

  it('emits JSON and SARIF that tools can consume', () => {
    const json = JSON.parse(capture(['sample', '--format', 'json']).out);
    expect(json.findings).toHaveLength(19);
    const sarif = JSON.parse(capture(['sample', '--format=sarif', '--fail-on', 'never']).out);
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].results).toHaveLength(19);
    expect(sarif.runs[0].results[0].locations[0].physicalLocation.region.startLine).toBeGreaterThan(0);
    expect(sarif.runs[0].tool.driver.rules.length).toBeGreaterThan(15);
  });

  it('--dry-run shows the diff and writes nothing; --fix rewrites files in place', () => {
    dir = mkdtempSync(join(tmpdir(), 'duo-'));
    cpSync('sample', dir, { recursive: true });
    const player = join(dir, 'Encore/Encore/PlayerViewController.swift');
    const before = readFileSync(player, 'utf8');

    const dry = capture([dir, '--dry-run']);
    expect(dry.out).toContain('-        let side = view.bounds.width - view.safeAreaInsets.left * 2');
    expect(dry.out).toContain('+        let side = view.bounds.inset(by: view.safeAreaInsets).width');
    expect(readFileSync(player, 'utf8')).toBe(before);

    const fixed = capture([dir, '--fix', '--no-color', '--fail-on', 'never']);
    expect(fixed.code).toBe(0);
    expect(fixed.out).toContain('Applied 2 fixes.');
    expect(readFileSync(player, 'utf8')).toContain('image(scale: UIScreen.main.scale)');
    expect(readFileSync(join(dir, 'Encore/Encore/LibraryView.swift'), 'utf8')).toContain('NavigationStack {');
  });

  it('survives symlink loops and prefixes SARIF paths from the git root', () => {
    dir = mkdtempSync(join(tmpdir(), 'duo-'));
    mkdirSync(join(dir, '.git'));
    mkdirSync(join(dir, 'ios/App'), { recursive: true });
    writeFileSync(join(dir, 'ios/App/A.swift'), 'let pad = UIDevice.current.userInterfaceIdiom == .pad');
    symlinkSync(join(dir, 'ios'), join(dir, 'ios/App/loop'));
    const sarif = JSON.parse(capture([join(dir, 'ios'), '--format', 'sarif']).out);
    expect(sarif.runs[0].results.map((r: { locations: { physicalLocation: { artifactLocation: { uri: string } } }[] }) => r.locations[0].physicalLocation.artifactLocation.uri)).toEqual([
      'ios/App/A.swift',
    ]);
  });

  it('explains bad input instead of crashing', () => {
    expect(capture(['--format', 'xml']).code).toBe(2);
    expect(capture(['does-not-exist']).out).toContain('No such file or folder');
    expect(capture(['src/core']).out).toContain('No Swift');
    expect(capture(['rules']).out).toContain('uiscreen-main');
    expect(capture(['--help']).code).toBe(0);
  });
});
