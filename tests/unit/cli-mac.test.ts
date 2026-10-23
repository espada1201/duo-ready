import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run, startDir } from '../../src/cli/main';

const capture = (argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, (s) => out.push(s), (s) => err.push(s));
  return { code, out: out.join('\n'), err: err.join('\n') };
};

describe('where relative paths start (npm run, npx, macOS and Windows paths)', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('uses INIT_CWD only while the script still runs in the folder npm started it in', () => {
    const env = { INIT_CWD: '/Users/me/Projects/My App', npm_package_json: '/Users/me/duo-ready/package.json' };
    expect(startDir(env, '/Users/me/duo-ready', 'darwin')).toBe('/Users/me/Projects/My App');
    expect(startDir(env, '/Users/me/Projects/My App', 'darwin')).toBe('/Users/me/Projects/My App');
    expect(startDir({ ...env, npm_package_json: '/Users/me/other/package.json' }, '/Users/me/duo-ready', 'darwin')).toBe('/Users/me/duo-ready');
  });

  it('under npx there is no kit package.json, so the folder you are in is the start', () => {
    expect(startDir({ INIT_CWD: '/Users/me/MyApp' }, '/Users/me/MyApp', 'darwin')).toBe('/Users/me/MyApp');
    expect(startDir({}, '/Users/me/MyApp', 'darwin')).toBe('/Users/me/MyApp');
    // npx run inside a Node project that sits above the folder: its package.json is not the cwd.
    expect(startDir({ INIT_CWD: '/Users/me/rn/ios', npm_package_json: '/Users/me/rn/package.json' }, '/Users/me/rn/ios', 'darwin')).toBe('/Users/me/rn/ios');
  });

  it('sees through symlinks, such as /tmp and /var being /private/... on a Mac', () => {
    dir = mkdtempSync(join(tmpdir(), 'duo-'));
    const real = join(realpathSync(dir), 'kit');
    mkdirSync(real);
    symlinkSync(real, join(dir, 'link'));
    const env = { INIT_CWD: '/start', npm_package_json: join(dir, 'link', 'package.json') };
    expect(startDir(env, real, 'darwin')).toBe('/start');
    expect(startDir(env, real, 'linux')).toBe('/start');
  });

  it('ignores letter case on macOS and Windows file systems, not on Linux', () => {
    const env = { INIT_CWD: '/start', npm_package_json: '/Users/Me/Kit/package.json' };
    expect(startDir(env, '/users/me/kit', 'darwin')).toBe('/start');
    expect(startDir(env, '/users/me/kit', 'win32')).toBe('/start');
    expect(startDir(env, '/users/me/kit', 'linux')).toBe('/users/me/kit');
  });

  it('expands ~ in a quoted path, since only the shell does it for unquoted ones', () => {
    dir = mkdtempSync(join(tmpdir(), 'duo-'));
    mkdirSync(join(dir, 'My Apps/Tunely'), { recursive: true });
    writeFileSync(join(dir, 'My Apps/Tunely/A.swift'), 'let s = UIScreen.main.scale');
    const home = process.env.HOME;
    try {
      process.env.HOME = dir;
      expect(capture(['~/My Apps/Tunely', '--no-color']).out).toContain('UIScreen.main');
      expect(capture(['~/My Apps/Tunely', '--no-color', '--out', '~/r.txt', '--fail-on', 'never']).code).toBe(0);
      expect(readFileSync(join(dir, 'r.txt'), 'utf8')).toContain('UIScreen.main');
      expect(capture(['~/Missing']).err).toContain(join(dir, 'Missing'));
    } finally {
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
    }
  });

  it('works in a folder with spaces that holds an .xcodeproj bundle, and says to quote an unquoted one', () => {
    dir = mkdtempSync(join(tmpdir(), 'duo-'));
    const app = join(dir, 'My App');
    mkdirSync(join(app, 'My App.xcodeproj'), { recursive: true });
    writeFileSync(join(app, 'My App.xcodeproj/project.pbxproj'), 'buildSettings = {\nINFOPLIST_KEY_UISupportedInterfaceOrientations = UIInterfaceOrientationPortrait;\n};');
    writeFileSync(join(app, 'View.swift'), 'import UIKit\nclass V: UIViewController {\n  override func viewDidLayoutSubviews() {\n    let side = view.bounds.width - view.safeAreaInsets.left * 2\n  }\n}\n');
    expect(capture([app, '--no-color']).out).toContain('Portrait-only app');
    expect(capture([app, '--fix', '--no-color', '--fail-on', 'never']).out).toContain('Applied 1 fix to View.swift.');
    expect(readFileSync(join(app, 'View.swift'), 'utf8')).toContain('view.bounds.inset(by: view.safeAreaInsets).width');
    expect(capture([join(dir, 'My'), 'App']).err).toContain('If the folder name has a space, put the path in quotes');
  });

  it('prefixes SARIF paths from the real location of a project reached through a symlink', () => {
    dir = mkdtempSync(join(tmpdir(), 'duo-'));
    const real = realpathSync(dir);
    mkdirSync(join(real, '.git'));
    mkdirSync(join(real, 'ios'));
    writeFileSync(join(real, 'ios/A.swift'), 'let pad = UIDevice.current.userInterfaceIdiom == .pad');
    mkdirSync(join(real, 'elsewhere'));
    symlinkSync(join(real, 'ios'), join(real, 'elsewhere/Link'));
    const uri = (s: string) => JSON.parse(s).runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;
    expect(uri(capture([join(real, 'elsewhere/Link'), '--format', 'sarif']).out)).toBe('ios/A.swift');
  });
});
