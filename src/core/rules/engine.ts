// What every rule module gets: the rule shape, the parsed file it is looking at, and
// what the first pass learned about the whole project.

import type { parsePlist } from '../plist';
import { blockAt, type Block, type SwiftSource } from '../swift';
import type { Fix, Severity, SourceFile } from '../types';

export interface Rule<Id extends string = string> {
  id: Id;
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
  /** UIApplicationSupportsMultipleScenes is on, so several of the app's scenes can be in the foreground at once. */
  multipleScenes: boolean;
  appDelegate: { file: SourceFile; offset: number } | null;
  /** Lowest iOS deployment target from the Xcode project, .xcconfig files or an XcodeGen spec. */
  deploymentTarget: number | null;
  /** The project also builds for watchOS, macOS, tvOS or visionOS, whose SwiftUI versions lag iOS. */
  otherPlatforms: boolean;
  /** The app declares its own `VideoPlayer` type, shadowing AVKit's. */
  ownVideoPlayer: boolean;
  /** Properties like `UIDevice.isPad` whose whole body is an idiom comparison. */
  idiomWrappers: string[];
  /** View modifiers like `square(size:)` whose whole body is `frame(width: size, height: size)`. */
  squareModifiers: string[];
  /** Views some caller in the project keeps to an aspect ratio: `ImageView(url: u).scaledToFit()`. */
  aspectViews: Set<string>;
  /** The project's SwiftUI views, true where one keeps state a rebuild throws away (@State, a ScrollView, a TextField…). */
  views: Map<string, boolean>;
  /** LastUpgradeCheck, e.g. "2600". */
  upgradeCheck: string | null;
  /** An Info.plist or project.pbxproj was given. */
  hasProjectFiles: boolean;
  /** Some Xcode project in the folder builds an app (not only frameworks or packages). */
  hasAppProject: boolean;
}

export type Report<Id extends string = string> = (ruleId: Id, offset: number, message?: string, fix?: Fix) => void;

interface Context<Id extends string = string> {
  file: SourceFile;
  facts: ProjectFacts;
  report: Report<Id>;
}

export interface ObjCContext<Id extends string = string> extends Context<Id> {
  /** The source with comments and string contents blanked. */
  masked: string;
  /** Offsets that are inside string literals. */
  strings: SwiftSource['strings'];
}

export interface SwiftContext<Id extends string = string> extends Context<Id> {
  src: SwiftSource;
  /** The source with comments and string contents blanked. */
  masked: string;
  blocks: Block[];
}

export interface PlistContext<Id extends string = string> extends Context<Id> {
  plist: NonNullable<ReturnType<typeof parsePlist>>;
}

export interface ProjectContext<Id extends string = string> {
  facts: ProjectFacts;
  reporterFor: (file: SourceFile) => Report<Id>;
}

/** A reviewer pain point, its root cause, and the rules that catch it. */
export interface RuleGroup<Id extends string = string> {
  id: string;
  title: string;
  /** What reviewers reported. */
  seen: string;
  /** Why it happens, from first principles. */
  cause: string;
  rules: readonly Rule<Id>[];
  swift?: (c: SwiftContext<Id>) => void;
  /** Objective-C .m files: the same problems, spelled the Objective-C way. */
  objc?: (c: ObjCContext<Id>) => void;
  plist?: (c: PlistContext<Id>) => void;
  pbxproj?: (c: Context<Id>) => void;
  /** package.json or pubspec.yaml. */
  manifest?: (c: Context<Id>) => void;
  html?: (c: Context<Id>) => void;
  /** Runs once after every file, for rules that need the whole project. */
  project?: (c: ProjectContext<Id>) => void;
}

/** Declares a group so that `report` only accepts the ids of the group's own rules. */
export const defineGroup = <const Id extends string>(group: RuleGroup<Id>): RuleGroup<Id> => group;

let pairsFor = '';
let pairs = new Int32Array(0);

/** Offset just past the bracket that closes the one at `open`, or -1. Strings are already masked. */
export function closeOf(masked: string, open: number): number {
  // One pass per file pairs every ( and {, so walking many chains stays linear even in broken code.
  if (masked !== pairsFor) {
    pairs = new Int32Array(masked.length).fill(-1);
    const stacks: Record<string, number[]> = { '(': [], '{': [] };
    const opener: Record<string, string> = { ')': '(', '}': '{' };
    for (let i = 0; i < masked.length; i++) {
      const c = masked[i];
      if (c === '(' || c === '{') stacks[c].push(i);
      else if (c === ')' || c === '}') {
        const at = stacks[opener[c]].pop();
        if (at !== undefined) pairs[at] = i + 1;
      }
    }
    pairsFor = masked;
  }
  return pairs[open];
}

export interface ModifierCall {
  name: string;
  /** Text inside the call's parentheses; trailing closures are not included. */
  args: string;
}

/** The chain of `.modifier(...) { ... }` calls starting at `from`, trailing closures included, and where it ends. */
export function modifierChain(masked: string, from: number): { end: number; calls: ModifierCall[] } {
  // `#if os(iOS)` … `#endif` may wrap modifiers inside a chain.
  const name = /(?:\s*#(?:if|elseif|else|endif)\b[^\n]*)*\s*\.(\w+)\s*/y;
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

/** A pattern for a size class in an expression: `horizontalSizeClass`, or a name it was bound to (`@Environment(\\.horizontalSizeClass) var hs`). */
export function sizeClassPattern(masked: string): string {
  const names = [...masked.matchAll(/@Environment\s*\(\s*\\\.(?:horizontal|vertical)SizeClass\s*\)\s*(?:(?:private|fileprivate)\s+)?var\s+(\w+)/g)].map((h) => h[1]);
  return `(?:\\w*[sS]izeClass\\w*${names.map((n) => `|${n}`).join('')})`;
}

/** The view a modifier chain starts from: `Button` for `Button { } label: { }.buttonStyle(…).frame(…)`. */
export function chainRoot(src: SwiftSource, at: number): { name: string | null; body?: Block } | null {
  const m = src.masked;
  for (let i = at, guard = 0; guard < 30; guard++) {
    let j = i - 1;
    while (j >= 0 && /\s/.test(m[j])) j--;
    // `#if os(iOS)` / `#endif` lines inside a chain hold no calls.
    const lineStart = m.lastIndexOf('\n', j) + 1;
    if (/^[ \t]*#/.test(m.slice(lineStart, j + 1))) {
      i = lineStart;
      continue;
    }
    if (m[j] === '}') {
      const body = blockAt(src.root, j - 1);
      return { name: body.label, body };
    }
    let start = j + 1;
    if (m[j] === ')') {
      for (let depth = 0; j >= 0; j--) {
        if (m[j] === ')') depth++;
        else if (m[j] === '(' && --depth === 0) break;
      }
      start = j;
    }
    const name = /([A-Za-z_]\w*)\s*$/.exec(m.slice(Math.max(0, start - 80), start));
    if (!name) return null;
    let k = start - (m.slice(Math.max(0, start - 80), start).length - name.index) - 1;
    while (k >= 0 && /\s/.test(m[k])) k--;
    if (m[k] !== '.') return { name: name[1] };
    i = k;
  }
  return null;
}

/** Name of the type or extension whose body holds `scope` (not `class func`, which is a member). */
export function enclosingType(m: string, scope: Block | null): string | null {
  for (let b = scope; b?.parent; b = b.parent) {
    const type = /\b(?:class|struct|enum|actor|extension)\s+(?!func\b|var\b|let\b)(\w+)[^{}]*$/.exec(m.slice(Math.max(0, b.open - 200), b.open));
    if (type) return type[1];
  }
  return null;
}
