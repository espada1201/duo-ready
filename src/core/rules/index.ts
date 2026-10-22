// The rule registry. Rules live with the reviewer pain point they prevent; this file
// parses each file once, learns project-wide facts, then hands every file to every group.

import { parseObjC } from '../objc';
import { parsePlist } from '../plist';
import { blockAt, declaredTypes, parseSwift, walk, type Block, type SwiftSource } from '../swift';
import { configDeploymentTarget, deploymentTarget, upgradeCheck } from '../sdk';
import { lineAround, lineStarts, position } from '../text';
import type { Finding, SourceFile } from '../types';
import { blackBars } from './blackBars';
import type { PlistContext, ProjectFacts, Report, Rule, RuleGroup } from './engine';
import { fold } from './fold';
import { hardware } from './hardware';
import { hinge } from './hinge';
import { misplaced } from './misplaced';
import { stretched } from './stretched';

export type { ProjectFacts, Rule } from './engine';

const TYPED = [blackBars, misplaced, stretched, fold, hinge, hardware] as const;
/** Every rule id, checked at compile time wherever one is written by hand. */
export type RuleId = (typeof TYPED)[number]['rules'][number]['id'];
const GROUPS: readonly RuleGroup[] = TYPED;

export const RULES: Rule[] = GROUPS.flatMap((g) => g.rules);
export const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]));

export interface PainPoint {
  id: string;
  title: string;
  seen: string;
  cause: string;
  rules: string[];
}

export const PAIN_POINTS: PainPoint[] = GROUPS.map(({ id, title, seen, cause, rules }) => ({ id, title, seen, cause, rules: rules.map((r) => r.id) }));

type Parsed =
  | { kind: 'swift' | 'objc'; file: SourceFile; src: SwiftSource }
  | { kind: 'plist'; file: SourceFile; plist: PlistContext['plist'] }
  | { kind: 'pbxproj' | 'manifest' | 'html'; file: SourceFile }
  /** An .xcconfig or XcodeGen spec: build settings only, no rules of its own. */
  | { kind: 'config'; file: SourceFile };

/** Keys only a watch app's Info.plist has; WKAppBoundDomains and friends belong to iPhone apps too. */
const WATCH_KEY = /^WK(WatchKitApp|CompanionAppBundleIdentifier|ApplicationType|Application|WatchOnly|RunsIndependentlyOfCompanionApp)$/;
/** Watch app code: its own target and display, never in the iPhone app's window. */
const WATCH_DIR = /(^|\/)[^/]*Watch[^/]*(?:App|Kit|Extension|OS)\//;
/** Builds for watchOS, macOS, tvOS or visionOS too, in a pbxproj, .xcconfig or XcodeGen spec. */
const OTHER_PLATFORM = /\b(?:WATCHOS|MACOSX|TVOS|XROS)_DEPLOYMENT_TARGET\b|SDKROOT\s*=\s*(?:watchos|macosx|appletvos|xros)\b|SUPPORTED_PLATFORMS\s*[=:][^\n]*\b(?:watchos|macosx|appletvos|xros)\b|\b(?:platform|supportedDestinations):[^\n]*\b(?:watchOS|tvOS|macOS|visionOS)\b|^[ \t]+(?:watchOS|tvOS|macOS|visionOS):[ \t]*["']?\d/m;

/** Watch app code: its own target and display, never in the iPhone app's window. A shared file that imports WatchKit only under `#if os(watchOS)` is still iPhone code. */
function isWatchCode(masked: string): boolean {
  if (/@WK(?:Extension|Application)DelegateAdaptor\b/.test(masked)) return true;
  for (const hit of masked.matchAll(/\bimport\s+WatchKit\b/g)) {
    const before = masked.slice(0, hit.index);
    const depth = (before.match(/^[ \t]*#if\b/gm)?.length ?? 0) - (before.match(/^[ \t]*#endif\b/gm)?.length ?? 0);
    if (depth <= 0) return true;
  }
  return false;
}

/** Comments in .xcconfig (`//`) and YAML (`#`) files, so a commented-out setting isn't read. */
const stripConfigComments = (text: string) => text.replace(/(^|[ \t])(?:\/\/|#).*$/gm, '$1');
/** `var isPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }`, with nothing else in the body. */
const SQUARE_MODIFIER = /\bfunc\s+(\w+)\s*\(\s*(?:_\s+)?(\w+)\s*:\s*CGFloat\b[^)]*\)\s*->\s*some\s+View\s*\{\s*(?:return\s+)?(?:self\s*\.\s*)?frame\s*\(\s*width\s*:\s*\2\s*,\s*height\s*:\s*\2\b/g;
const IDIOM_WRAPPER = /\bvar\s+(\w+)\s*:\s*Bool\s*\{\s*(?:return\s+)?(?:[\w.]+\.)?userInterfaceIdiom\s*==\s*\.(?:pad|phone)\s*\}/g;
const WIDGET = /\b(?:TimelineProvider|TimelineEntry|WidgetConfiguration|WidgetBundle|widgetAccentedRenderingMode)\b|@Environment\s*\(\s*\\\.widgetFamily\s*\)/;

function parse(file: SourceFile): Parsed | null {
  const name = file.path.split('/').pop()!;
  if (name.endsWith('.swift')) {
    if (WATCH_DIR.test(file.path)) return null;
    const src = parseSwift(file.content);
    if (isWatchCode(src.masked)) return null;
    // Home Screen widgets are laid out by WidgetKit, not in the app's window.
    return WIDGET.test(src.masked) ? null : { kind: 'swift', file, src };
  }
  if (/\.(mm?|h)$/.test(name)) return { kind: 'objc', file, src: parseObjC(file.content) };
  if (name.endsWith('.plist')) {
    const plist = parsePlist(file.content);
    // Watch apps and extensions have their own Info.plist; only the iPhone app's matters here.
    // Other plists (GoogleService-Info, settings bundles) carry no app keys and say nothing about the app.
    const keys = plist ? [...plist.keys.keys()] : [];
    const app = keys.some((k) => /^(CF|UI|LS)/.test(k)) && !keys.some((k) => k === 'NSExtension' || WATCH_KEY.test(k));
    return app ? { kind: 'plist', file, plist: plist! } : null;
  }
  // A Mac or TV project beside the iPhone one (Flutter's macos/Runner, say) says nothing about the iPhone app.
  if (name === 'project.pbxproj') return /SDKROOT\s*=/.test(file.content) && !/SDKROOT\s*=\s*iphoneos\b/.test(file.content) ? null : { kind: 'pbxproj', file };
  if (name === 'package.json' || name === 'pubspec.yaml') return { kind: 'manifest', file };
  if (/\.html?$/.test(name)) return { kind: 'html', file };
  if (name.endsWith('.xcconfig') || /^project[\w-]*\.ya?ml$/.test(name)) return { kind: 'config', file };
  return null;
}

function learn(parsed: Parsed[]): ProjectFacts {
  const facts: ProjectFacts = {
    swiftUIApp: false,
    sceneDelegate: false,
    sceneManifest: false,
    appDelegate: null,
    deploymentTarget: null,
    otherPlatforms: false,
    idiomWrappers: [],
    squareModifiers: [],
    ownVideoPlayer: false,
    upgradeCheck: null,
    hasProjectFiles: false,
  };
  const lower = (target: number | null) => {
    if (target !== null && (facts.deploymentTarget === null || target < facts.deploymentTarget)) facts.deploymentTarget = target;
  };
  for (const p of parsed) {
    if (p.kind === 'swift') {
      const m = p.src.masked;
      if (/@main(?:\s+@\w+(?:\([^)]*\))?|\s+(?:public|internal|final|nonisolated))*\s+struct\s+\w+\s*:\s*[^{]*\bApp\b/.test(m)) facts.swiftUIApp = true;
      if (/\bUIWindowSceneDelegate\b/.test(m)) facts.sceneDelegate = true;
      const appDelegate = /\bclass\s+\w+\s*:\s*[^{]*\bUIApplicationDelegate\b/.exec(m);
      if (appDelegate && !facts.appDelegate) facts.appDelegate = { file: p.file, offset: appDelegate.index };
      if (/\b(?:struct|class|enum|actor)\s+VideoPlayer\b/.test(m)) facts.ownVideoPlayer = true;
      for (const hit of m.matchAll(IDIOM_WRAPPER)) if (!facts.idiomWrappers.includes(hit[1])) facts.idiomWrappers.push(hit[1]);
      for (const hit of m.matchAll(SQUARE_MODIFIER)) if (!facts.squareModifiers.includes(hit[1])) facts.squareModifiers.push(hit[1]);
    } else if (p.kind === 'objc') {
      const m = p.src.masked;
      if (/\bUIWindowSceneDelegate\b/.test(m)) facts.sceneDelegate = true;
      const appDelegate = /@interface\s+\w+\s*:\s*\w+\s*<[^>]*\bUIApplicationDelegate\b/.exec(m);
      if (appDelegate && !facts.appDelegate) facts.appDelegate = { file: p.file, offset: appDelegate.index };
    } else if (p.kind === 'plist') {
      facts.hasProjectFiles = true;
      if (p.plist.keys.has('UIApplicationSceneManifest')) facts.sceneManifest = true;
    } else if (p.kind === 'pbxproj') {
      facts.hasProjectFiles = true;
      if (/INFOPLIST_KEY_UIApplicationSceneManifest_Generation\s*=\s*YES/.test(p.file.content)) facts.sceneManifest = true;
      facts.upgradeCheck ??= upgradeCheck(p.file.content)?.value ?? null;
      if (OTHER_PLATFORM.test(p.file.content)) facts.otherPlatforms = true;
      lower(deploymentTarget(p.file.content));
    } else if (p.kind === 'config') {
      const config = stripConfigComments(p.file.content);
      if (OTHER_PLATFORM.test(config)) facts.otherPlatforms = true;
      lower(configDeploymentTarget(config));
    }
  }
  return facts;
}

const SCREEN = /^(View|UI\w*ViewController|UI\w*View)$/;

/** The SwiftUI view or UIKit view controller whose declaration contains `offset`. */
function screenAt(src: SwiftSource, offset: number): string | undefined {
  let best: { name: string; size: number } | undefined;
  for (const t of declaredTypes(src)) {
    if (!t.block || offset < t.start || offset > t.block.close || !t.inherits.some((i) => SCREEN.test(i))) continue;
    const size = t.block.close - t.start;
    if (!best || size < best.size) best = { name: t.name, size };
  }
  return best?.name;
}

/** `static func previewView(...)`, `func frameForPreview()`: helpers only previews call. A plain `showLinkPreview()` is app code. */
const PREVIEW_FUNC = /\b(?:static\s+func\s+preview\w*|func\s+\w*For(?:Xcode)?Previews?)\s*(?:<[^>{]*>)?\s*\([^{]*$/;

const heads = new WeakMap<SwiftSource, [number, number][]>();

/** From each `#Preview` to its opening brace. */
function previewHeads(src: SwiftSource): [number, number][] {
  let out = heads.get(src);
  if (!out) {
    out = [...src.masked.matchAll(/#Preview\b/g)].map((hit) => [hit.index!, src.masked.indexOf('{', hit.index!)] as [number, number]);
    heads.set(src, out);
  }
  return out;
}

/** Xcode previews never ship, so their fixed sizes and fonts aren't the app's problem. */
function inPreview(src: SwiftSource, offset: number): boolean {
  const m = src.masked;
  for (let b: Block | null = blockAt(src.root, offset); b?.parent; b = b.parent) {
    if (b.label === 'Preview' || PREVIEW_FUNC.test(m.slice(Math.max(0, b.open - 300), b.open))) return true;
  }
  // `#Preview("Face ID button") {`: the title is part of the preview too.
  if (previewHeads(src).some(([from, to]) => offset >= from && offset < to)) return true;
  // `enum ListPickerPreview { static var standard: some View }`: sample data for the file's #Preview,
  // unlike a screen named `LinkPreview: View`.
  const feedsPreviews = previewHeads(src).length > 0;
  return declaredTypes(src).some(
    (t) =>
      t.block &&
      (t.inherits.includes('PreviewProvider') || t.name.endsWith('Previews') || (feedsPreviews && /Previews?$/.test(t.name) && !t.inherits.some((i) => SCREEN.test(i)))) &&
      offset > t.start &&
      offset < t.block.close,
  );
}

function reporter(file: SourceFile, findings: Finding[], src?: SwiftSource): Report {
  const starts = src?.lineStarts ?? lineStarts(file.content);
  return (ruleId, offset, message, fix) => {
    if (src && inPreview(src, offset)) return;
    const rule = RULE_BY_ID.get(ruleId)!;
    const { line, column } = position(starts, offset);
    findings.push({
      ruleId,
      severity: rule.severity,
      path: file.path,
      line,
      column,
      message: message ?? rule.why,
      excerpt: lineAround(file.content, starts[line - 1]).trim(),
      screen: src ? screenAt(src, offset) : undefined,
      fix,
    });
  };
}

export function checkFiles(files: SourceFile[]): { findings: Finding[]; facts: ProjectFacts } {
  const findings: Finding[] = [];
  const parsed = files.map(parse).filter((p): p is Parsed => p !== null);
  const facts = learn(parsed);

  for (const p of parsed) {
    if (p.kind === 'swift') {
      const ctx = { file: p.file, facts, report: reporter(p.file, findings, p.src), src: p.src, masked: p.src.masked, blocks: [...walk(p.src.root)] };
      for (const g of GROUPS) g.swift?.(ctx);
    } else if (p.kind === 'objc') {
      const ctx = { file: p.file, facts, report: reporter(p.file, findings, p.src), masked: p.src.masked, strings: p.src.strings };
      for (const g of GROUPS) g.objc?.(ctx);
    } else if (p.kind === 'plist') {
      const ctx = { file: p.file, facts, report: reporter(p.file, findings), plist: p.plist };
      for (const g of GROUPS) g.plist?.(ctx);
    } else if (p.kind !== 'config') {
      const ctx = { file: p.file, facts, report: reporter(p.file, findings) };
      for (const g of GROUPS) g[p.kind]?.(ctx);
    }
  }
  const swiftOf = new Map(parsed.flatMap((p) => (p.kind === 'swift' || p.kind === 'objc' ? [[p.file, p.src] as const] : [])));
  for (const g of GROUPS) g.project?.({ facts, reporterFor: (file) => reporter(file, findings, swiftOf.get(file)) });
  return { findings, facts };
}
