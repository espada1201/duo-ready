import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../../src/cli/main';

const NOTE = 'Exit code 1 means findings at error or worse remain, not that this run failed. --fail-on never exits 0.';

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
    // The fix summary closes the output too, after the long report.
    expect(fixed.out.trimEnd().split('\n').slice(-2)[0]).toBe('Applied 2 fixes to Encore/Encore/LibraryView.swift, Encore/Encore/PlayerViewController.swift.');
    expect(readFileSync(player, 'utf8')).toContain('image(scale: UIScreen.main.scale)');
    expect(readFileSync(join(dir, 'Encore/Encore/LibraryView.swift'), 'utf8')).toContain('NavigationStack {');

    const all = capture([dir, '--fix', 'all', '--format', 'json', '--fail-on', 'never']);
    expect(all.err).toContain('Applied 3 fixes to ');
    const again = capture([dir, '--dry-run']);
    expect(again.out).toBe('Nothing to fix.');
    expect(again.err).toBe(NOTE);
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

  it('leads the report with the verdict', () => {
    expect(capture(['sample', '--no-color']).out.split('\n')[0]).toBe('Duo readiness 10/100  Not ready. Details below, summary at the end.');
  });

  it('names an Android project instead of only saying nothing was found', () => {
    dir = mkdtempSync(join(tmpdir(), 'duo-'));
    mkdirSync(join(dir, 'app/src/main'), { recursive: true });
    writeFileSync(join(dir, 'settings.gradle'), "include ':app'");
    writeFileSync(join(dir, 'app/src/main/AndroidManifest.xml'), '<manifest/>');
    expect(capture([dir])).toMatchObject({ code: 2, err: expect.stringContaining('It looks like an Android project, and duo-ready only checks iPhone apps.') });
    expect(capture(['src/core']).err).not.toContain('looks like');
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
    const again = capture([dir, '--dry-run', '--fix', 'all']);
    expect(again.out).toBe('Nothing to fix.');
    expect(again.err).toBe(NOTE);
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

  it('reads relative paths, --out included, from where npm was run, unless a script moved on since', () => {
    dir = mkdtempSync(join(tmpdir(), 'duo-'));
    mkdirSync(join(dir, 'MyApp'));
    writeFileSync(join(dir, 'MyApp', 'A.swift'), 'let s = UIScreen.main.scale');
    const before = { INIT_CWD: process.env.INIT_CWD, npm_package_json: process.env.npm_package_json };
    try {
      process.env.INIT_CWD = dir;
      process.env.npm_package_json = join(process.cwd(), 'package.json');
      expect(capture(['MyApp', '--no-color', '--out', 'r.txt', '--fail-on', 'never']).code).toBe(0);
      expect(readFileSync(join(dir, 'r.txt'), 'utf8')).toContain('UIScreen.main');
      process.env.npm_package_json = join(dir, 'elsewhere', 'package.json');
      expect(capture(['MyApp']).err).toContain('No such file or folder');
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('adds each firing rule\'s advice to JSON', () => {
    const json = JSON.parse(capture(['sample', '--format', 'json']).out);
    expect(json.rules['uiscreen-main'].instead).toMatch(/traitCollection/);
    expect(Object.keys(json.rules)).toEqual([...new Set(json.findings.map((f: { ruleId: string }) => f.ruleId))]);
  });
});

describe('duo-ready CLI exit code note', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  const lastLine = (s: string) => s.trimEnd().split('\n').at(-1);

  it('ends a report, a dry run and a --fix run with what exit code 1 means while findings remain', () => {
    dir = mkdtempSync(join(tmpdir(), 'duo-'));
    cpSync('sample', dir, { recursive: true });
    for (const argv of [[dir], [dir, '--dry-run'], [dir, '--fix']]) {
      const r = capture([...argv, '--no-color']);
      expect(r.code).toBe(1);
      expect(lastLine(r.err)).toBe(NOTE);
      expect(r.out).not.toContain('Exit code');
    }
    expect(lastLine(capture(['sample', '--no-color', '--fail-on', 'warning']).err)).toBe(NOTE.replace('error or worse', 'warning or worse'));
  });

  it('stays quiet when the exit code is 0, and keeps JSON and SARIF on stdout clean', () => {
    const quiet = capture(['sample', '--no-color', '--fail-on', 'never']);
    expect(quiet.out + quiet.err).not.toContain('Exit code');
    const json = capture(['sample', '--format', 'json']);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out).findings).toHaveLength(31);
    expect(lastLine(json.err)).toBe(NOTE);
    const sarif = capture(['sample', '--format', 'sarif']);
    expect(sarif.code).toBe(1);
    expect(JSON.parse(sarif.out).runs[0].results.length).toBeGreaterThan(0);
    expect(sarif.out).not.toContain('Exit code');
    expect(lastLine(sarif.err)).toBe(NOTE);
  });

  describe('with --out', () => {
    let out: string | null = null;
    afterEach(() => {
      if (out) rmSync(out, { force: true });
      out = null;
    });

    it('writes the report to the file and keeps the note on stderr', () => {
      out = join(tmpdir(), `duo-${process.pid}.txt`);
      const r = capture(['sample', '--no-color', '--out', out]);
      expect(lastLine(r.err)).toBe(NOTE);
      expect(r.out).not.toContain('Exit code');
      expect(readFileSync(out, 'utf8')).not.toContain('Exit code');
    });
  });

  it('keeps a dry-run patch on stdout exactly as git apply wants it, with the note on stderr', () => {
    dir = mkdtempSync(join(tmpdir(), 'duo-'));
    cpSync('sample', dir, { recursive: true });
    const { out: patch, err } = capture([dir, '--dry-run', '--no-color']);
    expect(lastLine(err)).toBe(NOTE);
    expect(patch).not.toContain('Exit code');
    writeFileSync(join(dir, 'duo.patch'), patch);
    execFileSync('git', ['apply', '--check', 'duo.patch'], { cwd: dir });
  });
});
