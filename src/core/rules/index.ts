// The rule registry. Rules live with the reviewer pain point they prevent; this file
// parses each file once, learns project-wide facts, then hands every file to every group.

import { parsePlist } from '../plist';
import { blockAt, declaredTypes, parseSwift, walk, type Block, type SwiftSource } from '../swift';
import { deploymentTarget, upgradeCheck } from '../sdk';
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
  | { kind: 'swift'; file: SourceFile; src: SwiftSource }
  | { kind: 'plist'; file: SourceFile; plist: PlistContext['plist'] }
  | { kind: 'pbxproj' | 'manifest' | 'html'; file: SourceFile };

const WIDGET = /\b(?:TimelineProvider|TimelineEntry|WidgetConfiguration|WidgetBundle|widgetAccentedRenderingMode)\b|@Environment\s*\(\s*\\\.widgetFamily\s*\)/;

function parse(file: SourceFile): Parsed | null {
  const name = file.path.split('/').pop()!;
  if (name.endsWith('.swift')) {
    const src = parseSwift(file.content);
    // Home Screen widgets are laid out by WidgetKit, not in the app's window.
    return WIDGET.test(src.masked) ? null : { kind: 'swift', file, src };
  }
  if (name.endsWith('.plist')) {
    const plist = parsePlist(file.content);
    // Watch apps and extensions have their own Info.plist; only the iPhone app's matters here.
    // Other plists (GoogleService-Info, settings bundles) carry no app keys and say nothing about the app.
    const keys = plist ? [...plist.keys.keys()] : [];
    const app = keys.some((k) => /^(CF|UI|LS)/.test(k)) && !keys.some((k) => k === 'NSExtension' || k.startsWith('WK'));
    return app ? { kind: 'plist', file, plist: plist! } : null;
  }
  if (name === 'project.pbxproj') return { kind: 'pbxproj', file };
  if (name === 'package.json' || name === 'pubspec.yaml') return { kind: 'manifest', file };
  if (/\.html?$/.test(name)) return { kind: 'html', file };
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
    upgradeCheck: null,
    hasProjectFiles: false,
  };
  for (const p of parsed) {
    if (p.kind === 'swift') {
      const m = p.src.masked;
      if (/@main(?:\s+@\w+(?:\([^)]*\))?|\s+(?:public|internal|final|nonisolated))*\s+struct\s+\w+\s*:\s*[^{]*\bApp\b/.test(m)) facts.swiftUIApp = true;
      if (/\bUIWindowSceneDelegate\b/.test(m)) facts.sceneDelegate = true;
      const appDelegate = /\bclass\s+\w+\s*:\s*[^{]*\bUIApplicationDelegate\b/.exec(m);
      if (appDelegate && !facts.appDelegate) facts.appDelegate = { file: p.file, offset: appDelegate.index };
    } else if (p.kind === 'plist') {
      facts.hasProjectFiles = true;
      if (p.plist.keys.has('UIApplicationSceneManifest')) facts.sceneManifest = true;
    } else if (p.kind === 'pbxproj') {
      facts.hasProjectFiles = true;
      if (/INFOPLIST_KEY_UIApplicationSceneManifest_Generation\s*=\s*YES/.test(p.file.content)) facts.sceneManifest = true;
      facts.upgradeCheck ??= upgradeCheck(p.file.content)?.value ?? null;
      if (/\b(?:WATCHOS|MACOSX|TVOS|XROS)_DEPLOYMENT_TARGET\b|SDKROOT = (?:watchos|macosx|appletvos|xros)\b/.test(p.file.content)) facts.otherPlatforms = true;
      const target = deploymentTarget(p.file.content);
      if (target !== null && (facts.deploymentTarget === null || target < facts.deploymentTarget)) facts.deploymentTarget = target;
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

/** Xcode previews never ship, so their fixed sizes and fonts aren't the app's problem. */
function inPreview(src: SwiftSource, offset: number): boolean {
  for (let b: Block | null = blockAt(src.root, offset); b?.parent; b = b.parent) if (b.label === 'Preview') return true;
  return declaredTypes(src).some((t) => t.block && t.inherits.includes('PreviewProvider') && offset > t.start && offset < t.block.close);
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
    } else if (p.kind === 'plist') {
      const ctx = { file: p.file, facts, report: reporter(p.file, findings), plist: p.plist };
      for (const g of GROUPS) g.plist?.(ctx);
    } else {
      const ctx = { file: p.file, facts, report: reporter(p.file, findings) };
      for (const g of GROUPS) g[p.kind]?.(ctx);
    }
  }
  const swiftOf = new Map(parsed.flatMap((p) => (p.kind === 'swift' ? [[p.file, p.src] as const] : [])));
  for (const g of GROUPS) g.project?.({ facts, reporterFor: (file) => reporter(file, findings, swiftOf.get(file)) });
  return { findings, facts };
}
