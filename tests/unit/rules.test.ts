import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyFixes, audit } from '../../src/core/audit';
import { RULES } from '../../src/core/rules';
import type { SourceFile } from '../../src/core/types';

const swift = (content: string, path = 'App/View.swift'): SourceFile[] => [{ path, content }];
const ids = (files: SourceFile[]) => audit(files).findings.map((f) => f.ruleId);
const fixAll = (files: SourceFile[], level: 'safe' | 'all' = 'all') => applyFixes(files, audit(files).findings, level).files[0].content;

function readTree(dir: string): SourceFile[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? readTree(full) : [{ path: relative('sample/Encore', full), content: readFileSync(full, 'utf8') }];
  });
}

describe('rules', () => {
  it('every rule cites Apple guidance and says what to do instead', () => {
    for (const r of RULES) {
      expect(r.source).toMatch(/Apple/);
      expect(r.instead.length).toBeGreaterThan(10);
    }
  });

  it('UIScreen.main.scale in a view controller method gets a review-level trait collection fix', () => {
    const files = swift('final class A: UIViewController {\n  func f() { let s = UIScreen.main.scale }\n}');
    expect(ids(files)).toEqual(['uiscreen-main']);
    expect(fixAll(files, 'safe')).toContain('UIScreen.main.scale');
    expect(fixAll(files, 'all')).toContain('let s = traitCollection.displayScale');
  });

  it('UIScreen.main.bounds gets a review-only fix and none outside UIKit views', () => {
    const vc = swift('class A: UIViewController {\n  func f() { let b = UIScreen.main.bounds }\n}');
    expect(audit(vc).findings[0].fix?.confidence).toBe('review');
    expect(fixAll(vc, 'safe')).toContain('UIScreen.main.bounds');
    expect(fixAll(vc, 'all')).toContain('let b = view.bounds');
    const view = swift('class Cell: UICollectionViewCell {\n  func f() { let b = UIScreen.main.bounds }\n}');
    expect(fixAll(view)).toContain('let b = bounds');
    const free = swift('func f() { let b = UIScreen.main.bounds }');
    expect(audit(free).findings[0].fix).toBeUndefined();
  });

  it('ignores mentions in comments and strings', () => {
    expect(ids(swift('// UIScreen.main.scale\nlet s = "UIScreen.main and userInterfaceIdiom"'))).toEqual([]);
  });

  it('flags idiom and orientation checks', () => {
    expect(ids(swift('let pad = UIDevice.current.userInterfaceIdiom == .pad\nif UIDevice.current.orientation.isLandscape {}'))).toEqual([
      'idiom-layout',
      'orientation-layout',
    ]);
  });

  it('rewrites symmetric safe-area math only when axis and receiver match', () => {
    const files = swift('let w = view.bounds.width - view.safeAreaInsets.left * 2');
    expect(fixAll(files, 'safe')).toBe('let w = view.bounds.inset(by: view.safeAreaInsets).width');
    const mismatched = swift('let w = view.bounds.width - other.safeAreaInsets.left * 2');
    expect(audit(mismatched).findings).toHaveLength(1);
    expect(audit(mismatched).findings[0].fix).toBeUndefined();
  });

  it('flags iPhone point sizes but not arbitrary numbers', () => {
    expect(ids(swift('Text("a").frame(width: 390)\nRect(height: 844)'))).toEqual(['fixed-device-size', 'fixed-device-size']);
    expect(ids(swift('Text("a").frame(width: 391, height: 390)'))).toEqual([]);
  });

  it('flags hand-built bars', () => {
    expect(ids(swift('let t = UIToolbar()\nstruct PlayerTabBar: View { var body: some View { EmptyView() } }'))).toEqual([
      'hand-built-bar',
      'hand-built-bar',
    ]);
  });

  it('replaces single-column NavigationView with NavigationStack', () => {
    const files = swift('NavigationView {\n  List { Text("a") }\n}');
    expect(fixAll(files, 'safe')).toBe('NavigationStack {\n  List { Text("a") }\n}');
    const twoColumn = swift('NavigationView {\n  Sidebar()\n  Detail()\n}');
    expect(audit(twoColumn).findings[0].fix).toBeUndefined();
  });

  it('enforces Apple’s ArrangementView nesting rules', () => {
    const bad = swift('List {\n  ArrangementView {\n    A()\n  } secondary: {\n    NavigationSplitView { S() } detail: { D() }\n  }\n}');
    expect(ids(bad).sort()).toEqual(['arrangement-in-scroll', 'navigation-in-arrangement']);
    const good = swift('NavigationStack {\n  ArrangementView {\n    A()\n  } secondary: {\n    List { B() }\n  }\n}');
    expect(ids(good)).toEqual([]);
  });

  it('offers a sidebar for TabView unless one is already set', () => {
    const files = swift('    TabView {\n      A()\n    }\n    .tint(.red)');
    expect(fixAll(files)).toBe('    TabView {\n      A()\n    }\n    .defaultTabBarPlacement(.sidebar)\n    .tint(.red)');
    expect(ids(swift('TabView {\n  A()\n}\n.tint(.red)\n.defaultTabBarPlacement(.sidebar)'))).toEqual([]);
  });

  it('spots centered columns and hand-rolled two-pane layouts', () => {
    const files = swift('if horizontalSizeClass == .regular {\n  HStack { A(); B() }\n} else {\n  A().frame(maxWidth: 500)\n}');
    const found = audit(files).findings;
    expect(found.map((f) => [f.ruleId, f.line])).toEqual([
      ['manual-two-pane', 1],
      ['centered-column', 4],
    ]);
  });

  it('reads Info.plist and build settings', () => {
    const plist = `<plist><dict><key>UIRequiresFullScreen</key><true/><key>UISupportedInterfaceOrientations</key><array><string>UIInterfaceOrientationPortrait</string></array></dict></plist>`;
    expect(ids([{ path: 'Info.plist', content: plist }]).sort()).toEqual(['portrait-only', 'requires-full-screen']);
    const both = plist.replace('</array>', '<string>UIInterfaceOrientationLandscapeLeft</string></array>');
    expect(ids([{ path: 'Info.plist', content: both }])).toEqual(['requires-full-screen']);
    const pbx = 'LastUpgradeCheck = 2700;\nINFOPLIST_KEY_UISupportedInterfaceOrientations = "UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown";';
    const result = audit([{ path: 'A.xcodeproj/project.pbxproj', content: pbx }]);
    expect(result.findings.map((f) => f.ruleId).sort()).toEqual(['old-sdk', 'portrait-only']);
    expect(result.tier?.value).toBe('27');
    expect(audit([{ path: 'A.xcodeproj/project.pbxproj', content: 'LastUpgradeCheck = 2710;' }]).findings).toEqual([]);
  });

  it('requires the scene lifecycle for UIKit apps but not SwiftUI apps', () => {
    const delegate = 'class AppDelegate: UIResponder, UIApplicationDelegate {}';
    expect(ids(swift(delegate))).toEqual(['no-scene-lifecycle']);
    expect(ids([...swift(delegate), ...swift('@main struct Encore: App { var body: some Scene { WindowGroup { A() } } }', 'App/App.swift')])).toEqual([]);
    const scenes = [
      ...swift(delegate),
      ...swift('class SceneDelegate: UIResponder, UIWindowSceneDelegate {}', 'App/Scene.swift'),
      { path: 'App/Info.plist', content: '<plist><dict><key>UIApplicationSceneManifest</key><dict/></dict></plist>' },
    ];
    expect(ids(scenes)).toEqual([]);
  });

  it('notes cross-platform frameworks and skips vendored code', () => {
    expect(ids([{ path: 'package.json', content: '{"dependencies":{"react-native":"0.80.0"}}' }])).toEqual(['cross-platform']);
    expect(ids([{ path: 'pubspec.yaml', content: 'name: a\nflutter:\n  uses-material-design: true' }])).toEqual(['cross-platform']);
    expect(ids(swift('let s = UIScreen.main.scale', 'Pods/Lib/A.swift'))).toEqual([]);
  });
});

describe('sample project (Encore)', () => {
  const files = readTree('sample');
  const result = audit(files);

  it('finds every planted Duo problem with its location', () => {
    const where = result.findings.map((f) => `${f.ruleId} ${f.path}:${f.line}`);
    expect(where).toEqual([
      'no-scene-lifecycle Encore/AppDelegate.swift:5',
      'uiscreen-main Encore/AppDelegate.swift:9',
      'arrangement-in-scroll Encore/NowPlayingView.swift:6',
      'navigation-in-arrangement Encore/NowPlayingView.swift:9',
      'uiscreen-main Encore/PlayerViewController.swift:12',
      'old-sdk Encore.xcodeproj/project.pbxproj:13',
      'portrait-only Encore.xcodeproj/project.pbxproj:28',
      'portrait-only Encore/Info.plist:11',
      'idiom-layout Encore/LibraryView.swift:24',
      'fixed-device-size Encore/LibraryView.swift:51',
      'hand-built-bar Encore/LibraryView.swift:55',
      'hand-built-bar Encore/PlayerViewController.swift:5',
      'symmetric-safe-area Encore/PlayerViewController.swift:17',
      'orientation-layout Encore/PlayerViewController.swift:21',
      'requires-full-screen Encore/Info.plist:9',
      'tab-sidebar Encore/LibraryView.swift:8',
      'navigation-view Encore/LibraryView.swift:9',
      'manual-two-pane Encore/LibraryView.swift:28',
      'centered-column Encore/LibraryView.swift:35',
    ]);
    expect(result.tier).toEqual({ value: '26', source: 'LastUpgradeCheck 2600, Xcode 26.0' });
    expect(result.grade).toBe('Not ready');
  });

  it('safe fixes remove their findings, leave the rest, and are idempotent', () => {
    const { files: fixed, applied } = applyFixes(files, result.findings, 'safe');
    expect(applied.map((f) => f.ruleId).sort()).toEqual(['navigation-view', 'symmetric-safe-area']);
    const after = audit(fixed);
    expect(after.findings).toHaveLength(result.findings.length - applied.length);
    expect(after.score).toBeGreaterThan(result.score);
    const again = applyFixes(fixed, after.findings, 'safe');
    expect(again.applied).toEqual([]);
    expect(again.files).toEqual(fixed);
  });
});
