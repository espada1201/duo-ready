import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
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

  it('says when an Info.plist is binary instead of claiming there is none', () => {
    dir = mkdtempSync(join(tmpdir(), 'duo-'));
    writeFileSync(join(dir, 'Info.plist'), Buffer.from('bplist00\xd1\x01\x02', 'latin1'));
    writeFileSync(join(dir, 'A.swift'), 'let a = 1');
    expect(capture([dir, '--no-color']).out).toContain('Info.plist is a binary plist');
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
    expect(out).toContain('2 safe fixes (--fix), 3 review fixes (--fix all).');
    expect(out).toMatch(/Fix these first\n  NowPlayingView +\+16 points +2 errors/);
    expect(out).toContain('AppDelegate.swift');
    expect(out).toContain('Not ready  (Duo-ready 90+');
    expect(out.match(/Instead: Read scale from traitCollection/g)).toHaveLength(1);
    expect(out).toMatch(/warning  .*\[safe fix\]/);
    expect(out).not.toMatch(/\binfo\b|warn /);
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
    expect(fixed.out).toContain('Applied 2 fixes to Encore/Encore/LibraryView.swift, Encore/Encore/PlayerViewController.swift.');
    expect(fixed.out).toContain('git diff');
    expect(readFileSync(player, 'utf8')).toContain('image(scale: UIScreen.main.scale)');
    expect(readFileSync(join(dir, 'Encore/Encore/LibraryView.swift'), 'utf8')).toContain('NavigationStack {');

    const all = capture([dir, '--fix', 'all', '--format', 'json', '--fail-on', 'never']);
    expect(all.err).toContain('Applied 3 fixes to ');
    expect(capture([dir, '--dry-run']).out).toBe('Nothing to fix.');
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
    expect(capture(['--fix', 'everything'])).toMatchObject({ code: 2, err: expect.stringContaining('--fix takes "safe" or "all"') });
    expect(capture(['--fail-on', 'info']).err).toContain('--fail-on takes "error", "warning", "note" or "never", not "info"');
    expect(capture(['README.md']).err).toContain('No Swift');
    expect(capture(['does-not-exist']).err).toContain('Paths are relative to the folder you ran the command in');
    expect(capture(['rules']).out).toMatch(/^Black bars\n=+\n/);
    expect(capture(['rules']).out).toContain('Breaks when you fold or unfold');
    expect(capture(['--help']).out).toContain('Exit codes');
    expect(capture(['--help']).code).toBe(0);
  });
});

describe('duo-ready CLI dry run', () => {
  it('keeps stdout a valid report with --format json, and sends the diff to stderr', () => {
    const out: string[] = [];
    const err: string[] = [];
    run(['sample', '--dry-run', '--format', 'json', '--fail-on', 'never'], (s) => out.push(s), (s) => err.push(s));
    expect(JSON.parse(out.join('\n')).findings.length).toBeGreaterThan(0);
    expect(err.join('\n')).toContain('+++ b/Encore/Encore/LibraryView.swift');
  });
});

describe('duo-ready CLI patches and exit codes', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('prints a patch git apply accepts, with each fix described above it', () => {
    dir = mkdtempSync(join(tmpdir(), 'duo-'));
    cpSync('sample', dir, { recursive: true });
    const patch = capture([dir, '--dry-run', '--fix', 'all', '--no-color']).out;
    expect(patch).toContain('# Encore/Encore/PlayerViewController.swift:17 Inset by every side of the safe area. [safe fix]');
    expect(patch).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
    writeFileSync(join(dir, 'duo.patch'), patch);
    execFileSync('git', ['apply', '--check', 'duo.patch'], { cwd: dir });
    execFileSync('git', ['apply', 'duo.patch'], { cwd: dir });
    expect(capture([dir, '--dry-run', '--fix', 'all']).out).toBe('Nothing to fix.');
  });

  it('patches files with Windows line endings or no final newline', () => {
    dir = mkdtempSync(join(tmpdir(), 'duo-'));
    const body = (eol: string) => ['import UIKit', 'class V: UIViewController {', '  override func viewDidLayoutSubviews() {', '    let side = view.bounds.width - view.safeAreaInsets.left * 2', '  }', '}'].join(eol);
    writeFileSync(join(dir, 'Crlf.swift'), body('\r\n') + '\r\n');
    writeFileSync(join(dir, 'NoEol.swift'), body('\n'));
    const patch = capture([dir, '--dry-run', '--no-color']).out;
    expect(patch).toContain('\\ No newline at end of file');
    writeFileSync(join(dir, 'duo.patch'), patch);
    execFileSync('git', ['apply', 'duo.patch'], { cwd: dir });
    expect(readFileSync(join(dir, 'Crlf.swift'), 'utf8')).toBe(body('\r\n').replace('view.bounds.width - view.safeAreaInsets.left * 2', 'view.bounds.inset(by: view.safeAreaInsets).width') + '\r\n');
    expect(readFileSync(join(dir, 'NoEol.swift'), 'utf8').endsWith('}')).toBe(true);
  });

  it('says when only review fixes are left', () => {
    dir = mkdtempSync(join(tmpdir(), 'duo-'));
    writeFileSync(join(dir, 'A.swift'), 'struct V: View {\n  var body: some View {\n    Image(uiImage: img).resizable()\n  }\n}');
    expect(capture([dir, '--dry-run']).out).toBe('No safe fixes. 1 review fix needs a human look: --dry-run --fix all shows it.');
  });

  it('fails at the chosen severity or worse', () => {
    dir = mkdtempSync(join(tmpdir(), 'duo-'));
    writeFileSync(join(dir, 'A.swift'), 'Text("Unlock with Face ID")');
    expect(capture([dir]).code).toBe(0);
    expect(capture([dir, '--fail-on', 'warning']).code).toBe(0);
    expect(capture([dir, '--fail-on', 'note']).code).toBe(1);
  });

  it('reads relative paths from where npm was run, not the package root', () => {
    dir = mkdtempSync(join(tmpdir(), 'duo-'));
    mkdirSync(join(dir, 'MyApp'));
    writeFileSync(join(dir, 'MyApp', 'A.swift'), 'let s = UIScreen.main.scale');
    const before = process.env.INIT_CWD;
    process.env.INIT_CWD = dir;
    try {
      expect(capture(['MyApp', '--no-color']).out).toContain('UIScreen.main');
    } finally {
      if (before === undefined) delete process.env.INIT_CWD;
      else process.env.INIT_CWD = before;
    }
  });

  it('adds each firing rule\'s advice to JSON', () => {
    const json = JSON.parse(capture(['sample', '--format', 'json']).out);
    expect(json.rules['uiscreen-main'].instead).toMatch(/traitCollection/);
    expect(Object.keys(json.rules)).toEqual([...new Set(json.findings.map((f: { ruleId: string }) => f.ruleId))]);
  });
});
