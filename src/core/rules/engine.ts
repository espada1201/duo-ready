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
  /** The project also builds for watchOS, macOS, tvOS or visionOS, whose SwiftUI versions lag iOS. */
  otherPlatforms: boolean;
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

/** Offset just past the bracket that closes the one at `open`, or -1. Strings are already masked. */
function closeOf(masked: string, open: number): number {
  const pair = masked[open] === '(' ? ')' : '}';
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === masked[open]) depth++;
    else if (masked[i] === pair && --depth === 0) return i + 1;
  }
  return -1;
}

export interface ModifierCall {
  name: string;
  /** Text inside the call's parentheses; trailing closures are not included. */
  args: string;
}

/** The chain of `.modifier(...) { ... }` calls starting at `from`, trailing closures included, and where it ends. */
export function modifierChain(masked: string, from: number): { end: number; calls: ModifierCall[] } {
  const name = /\s*\.(\w+)\s*/y;
  const closure = /\s*(?:\w+\s*:\s*)?(?=\{)/y;
  const calls: ModifierCall[] = [];
  let at = from;
  for (;;) {
    name.lastIndex = at;
    const hit = name.exec(masked);
    if (!hit) return { end: at, calls };
    let end = at + hit[0].length;
    let args = '';
    if (masked[end] === '(') {
      const close = closeOf(masked, end);
      if (close < 0) return { end: at, calls };
      args = masked.slice(end + 1, close - 1);
      end = close;
    }
    for (let closures = 0; ; closures++) {
      closure.lastIndex = end;
      const c = closure.exec(masked);
      // Only the first trailing closure is unlabelled; `label: {` before it is a new statement.
      if (!c || (closures === 0 && c[0].includes(':'))) break;
      const close = closeOf(masked, end + c[0].length);
      if (close < 0) break;
      end = close;
    }
    calls.push({ name: hit[1], args });
    at = end;
  }
}

/** Whether the chain at `from` calls `name`, optionally with arguments matching `args`. */
export const chainHas = (masked: string, from: number, name: RegExp, args?: RegExp): boolean =>
  modifierChain(masked, from).calls.some((c) => name.test(c.name) && (!args || args.test(c.args)));

/** Offset of `re` (anchored with `$`) in the text just before `open`, such as the `if` that owns a block. */
export function matchBefore(masked: string, open: number, re: RegExp): number | null {
  const head = masked.slice(Math.max(0, open - 80), open);
  const hit = re.exec(head);
  return hit ? open - head.length + hit.index : null;
}

/** Whether the name at `at` is being declared (a property, function or enum case) rather than read. */
export const declaredAt = (masked: string, at: number): boolean => matchBefore(masked, at, /\b(?:case\s+\.?|var\s+|let\s+|func\s+)$/) !== null;
