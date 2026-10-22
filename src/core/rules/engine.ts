// What every rule module gets: the rule shape, the parsed file it is looking at, and
// what the first pass learned about the whole project.

import type { parsePlist } from '../plist';
import type { Block, SwiftSource } from '../swift';
import type { Fix, Severity, SourceFile } from '../types';

export interface Rule {
  id: string;
  title: string;
  severity: Severity;
  /** Why it matters on iPhone Duo, in one or two sentences. */
  why: string;
  /** What Apple says to do instead. */
  instead: string;
  /** Apple session or document the guidance comes from. */
  source: string;
  /** Needs an Info.plist or Xcode project, so it can't run on pasted code. */
  project?: true;
}

export const PREPARE = 'Apple Tech Talk “Prepare your app for iPhone Duo”';
export const POSE = 'Apple Tech Talk “Strike a pose with adaptive layouts on iPhone Duo”';

export interface ProjectFacts {
  swiftUIApp: boolean;
  sceneDelegate: boolean;
  sceneManifest: boolean;
  appDelegate: { file: SourceFile; offset: number } | null;
  /** Lowest IPHONEOS_DEPLOYMENT_TARGET, when an Xcode project was given. */
  deploymentTarget: number | null;
  /** LastUpgradeCheck, e.g. "2600". */
  upgradeCheck: string | null;
  /** An Info.plist or project.pbxproj was given. */
  hasProjectFiles: boolean;
}

export type Report = (ruleId: string, offset: number, message?: string, fix?: Fix) => void;

interface Context {
  file: SourceFile;
  facts: ProjectFacts;
  report: Report;
}

export interface SwiftContext extends Context {
  src: SwiftSource;
  /** The source with comments and string contents blanked. */
  masked: string;
  blocks: Block[];
}

export interface PlistContext extends Context {
  plist: NonNullable<ReturnType<typeof parsePlist>>;
}

export interface ProjectContext {
  facts: ProjectFacts;
  reporterFor: (file: SourceFile) => Report;
}

/** A reviewer pain point, its root cause, and the rules that catch it. */
export interface RuleGroup {
  id: string;
  title: string;
  /** What reviewers reported. */
  seen: string;
  /** Why it happens, from first principles. */
  cause: string;
  rules: Rule[];
  swift?: (c: SwiftContext) => void;
  plist?: (c: PlistContext) => void;
  pbxproj?: (c: Context) => void;
  /** package.json or pubspec.yaml. */
  manifest?: (c: Context) => void;
  html?: (c: Context) => void;
  /** Runs once after every file, for rules that need the whole project. */
  project?: (c: ProjectContext) => void;
}

/** End offset of a chain of `.modifier(...)` calls starting at `from`. */
export function afterModifiers(masked: string, from: number): number {
  const re = /^\s*\.\w+\s*(\((?:[^()]|\([^()]*\))*\))?/;
  let at = from;
  for (;;) {
    const hit = re.exec(masked.slice(at));
    if (!hit) return at;
    at += hit[0].length;
  }
}

/** Offset of `re` (anchored with `$`) in the text just before `open`, such as the `if` that owns a block. */
export function matchBefore(masked: string, open: number, re: RegExp): number | null {
  const head = masked.slice(Math.max(0, open - 80), open);
  const hit = re.exec(head);
  return hit ? open - head.length + hit.index : null;
}

/** Whether the name at `at` is being declared (a property, function or enum case) rather than read. */
export const declaredAt = (masked: string, at: number): boolean => matchBefore(masked, at, /\b(?:case\s+\.?|var\s+|let\s+|func\s+)$/) !== null;
