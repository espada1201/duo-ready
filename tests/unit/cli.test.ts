import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../../src/cli/main';

const capture = (argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, (s) => out.push(s), (s) => err.push(s));
  return { code, out: out.join('\n'), err: err.join('\n') };
};

describe('duo-ready CLI', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('exits 2 on an unwritable report and on a second path', () => {
    expect(capture(['sample', '--out', '/nonexistent/r.txt'])).toMatchObject({ code: 2, err: expect.stringContaining('Could not write the report') });
    expect(capture(['sample', 'tests'])).toMatchObject({ code: 2, err: expect.stringContaining('One project at a time') });
  });

  it('audits an .xcodeproj folder or its project.pbxproj on its own', () => {
    dir = mkdtempSync(join(tmpdir(), 'duo-'));
    const proj = join(dir, 'App.xcodeproj');
    mkdirSync(proj);
    writeFileSync(join(proj, 'project.pbxproj'), 'buildSettings = {\nINFOPLIST_KEY_UISupportedInterfaceOrientations = UIInterfaceOrientationPortrait;\n};');
    expect(capture([proj, '--no-color']).out).toContain('Portrait-only app');
    expect(capture([join(proj, 'project.pbxproj'), '--no-color']).out).toContain('Portrait-only app');
  });

  it('prints a readable report and exits 1 when errors remain', () => {
    const { code, out } = capture(['sample', '--no-color']);
    expect(code).toBe(1);
    expect(out).toContain('Encore/Encore/NowPlayingView.swift');
    expect(out).toMatch(/Duo readiness \d+\/100 {2}Not ready/);
    expect(out).toContain('2 safe fixes (--fix), 3 more for review (--fix all).');
    expect(out).toMatch(/Fix these screens first\n  PlayerViewController +2 errors, 2 warnings/);
  });

  it('emits JSON and SARIF that tools can consume', () => {
    const json = JSON.parse(capture(['sample', '--format', 'json']).out);
    expect(json.findings).toHaveLength(31);
    const sarif = JSON.parse(capture(['sample', '--format=sarif', '--fail-on', 'never']).out);
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].results).toHaveLength(31);
    expect(sarif.runs[0].results[0].locations[0].physicalLocation.region.startLine).toBeGreaterThan(0);
    expect(sarif.runs[0].tool.driver.rules.length).toBeGreaterThan(15);

    dir = mkdtempSync(join(tmpdir(), 'duo-'));
    mkdirSync(join(dir, 'Tracking Protection'));
    writeFileSync(join(dir, 'Tracking Protection', 'View #1.swift'), 'let s = UIScreen.main.scale');
    const spaced = JSON.parse(capture([dir, '--format', 'sarif', '--fail-on', 'never']).out);
    expect(spaced.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toMatch(/Tracking%20Protection\/View%20%231\.swift$/);
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

    const all = capture([dir, '--fix', 'all', '--format', 'json', '--fail-on', 'never']);
    expect(all.err).toContain('Applied 3 fixes.');
    expect(JSON.parse(all.out).findings.some((f: { fix?: object }) => f.fix)).toBe(false);
  });

  it('marks audits without project files as partial', () => {
    dir = mkdtempSync(join(tmpdir(), 'duo-'));
    writeFileSync(join(dir, 'A.swift'), 'let x = 1');
    const { out } = capture([dir, '--no-color']);
    expect(out).toContain('Partial audit');
    expect(out).toContain('Close');
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
    expect(capture(['does-not-exist']).err).toContain('No such file or folder');
    expect(capture(['src/core']).err).toContain('No Swift');
    expect(capture(['rules']).out).toContain('uiscreen-main');
    expect(capture(['--no-color', 'rules']).out).toContain('keyboard-frame');
    expect(capture(['--fix', 'everything']).code).toBe(2);
    expect(capture(['--help']).code).toBe(0);
  });
});

describe('duo-ready CLI dry run', () => {
  it('keeps stdout a valid report with --format json, and sends the diff to stderr', () => {
    const out: string[] = [];
    const err: string[] = [];
    run(['sample', '--dry-run', '--format', 'json', '--fail-on', 'never'], (s) => out.push(s), (s) => err.push(s));
    expect(JSON.parse(out.join('\n')).findings.length).toBeGreaterThan(0);
    expect(err.join('\n')).toContain('+++ Encore/Encore/LibraryView.swift');
  });
});
