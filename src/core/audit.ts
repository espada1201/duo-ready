import { cost, SEVERITY_ORDER } from './findings';
import { checkFiles } from './rules';
import { tierFromUpgradeCheck, xcodeVersion } from './sdk';
import type { AuditResult, Finding, SourceFile } from './types';

const SKIP_DIR = /(^|\/)(Pods|Carthage|DerivedData|node_modules|build|SourcePackages|fastlane|\.[^/]+|\w*Tests|\w*Mocks|TestHelpers|TestSupport|Preview Content|Previews|ThirdParty|third_party|[Vv]endor)\//;
/** Test code and build scripts run on a Mac or in CI; they aren't what Duo users see. */
const TEST_FILE = /((Tests|\.test)\.swift|(^|\/)(Dangerfile|Package)\.swift)$/;
const RELEVANT = /(\.swift|\.mm?|\.plist|\.html?|\.xcconfig|(^|\/)project\.pbxproj|(^|\/)project[\w-]*\.ya?ml|(^|\/)package\.json|(^|\/)pubspec\.yaml)$/;

/** Files larger than this are skipped: generated code, not something to audit. */
export const MAX_BYTES = 2_000_000;

export function isRelevant(path: string): boolean {
  return RELEVANT.test(path) && !SKIP_DIR.test(path) && !TEST_FILE.test(path);
}

/** Whether a folder can hold relevant files: vendored and hidden folders can't. */
export function isRelevantDir(path: string): boolean {
  return !SKIP_DIR.test(`${path}/`);
}

/** Each rule costs once however often it fires: the score measures kinds of problem, not volume. */
function score(findings: Finding[]): number {
  return Math.max(0, 100 - cost(findings));
}

function grade(value: number, findings: Finding[], partial: boolean): AuditResult['grade'] {
  const errors = findings.some((f) => f.severity === 'error');
  // Without the project files, orientation, full-screen and SDK checks never ran.
  if (value >= 90 && !errors && !partial) return 'Duo-ready';
  if (value >= 70) return 'Close';
  if (value >= 40) return 'Needs work';
  return 'Not ready';
}

/** Objective-C is read only to count it: the rules understand Swift. */
const OBJC = /\.mm?$/;

export function audit(input: SourceFile[]): AuditResult {
  const relevant = input.filter((f) => isRelevant(f.path));
  const files = relevant.filter((f) => !OBJC.test(f.path));
  const { findings, facts } = checkFiles(files);
  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.path.localeCompare(b.path) ||
      a.line - b.line ||
      a.column - b.column ||
      a.ruleId.localeCompare(b.ruleId),
  );
  const value = score(findings);
  const partial = !facts.hasProjectFiles;
  const check = facts.upgradeCheck;
  return {
    files: files.length,
    swiftFiles: files.filter((f) => f.path.endsWith('.swift')).length,
    findings,
    score: value,
    grade: grade(value, findings, partial),
    tier: check ? { value: tierFromUpgradeCheck(check), source: `LastUpgradeCheck ${check}, Xcode ${xcodeVersion(check)}` } : null,
    partial,
    objcFiles: relevant.length - files.length,
    unreadable: files.filter((f) => /(^|\/)Info\.plist$/.test(f.path) && f.content.startsWith('bplist')).map((f) => f.path),
  };
}

/**
 * Applies fixes file by file. Overlapping edits are skipped rather than merged, so a
 * fix is either applied whole or not at all.
 */
export function applyFixes(
  files: SourceFile[],
  findings: Finding[],
  level: 'safe' | 'all',
): { files: SourceFile[]; applied: Finding[] } {
  const byPath = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!f.fix || (level === 'safe' && f.fix.confidence !== 'safe')) continue;
    byPath.set(f.path, [...(byPath.get(f.path) ?? []), f]);
  }
  const applied: Finding[] = [];
  const out = files.map((file) => {
    const fixes = byPath.get(file.path);
    if (!fixes) return file;
    const accepted: Finding[] = [];
    const taken: [number, number][] = [];
    for (const f of fixes) {
      const spans = f.fix!.edits.map((e) => [e.start, e.end] as [number, number]);
      const clash = spans.some(([s, e]) => taken.some(([ts, te]) => s < te && ts < e || (s === e && s === ts)));
      if (clash) continue;
      taken.push(...spans);
      accepted.push(f);
    }
    const edits = accepted.flatMap((f) => f.fix!.edits).sort((a, b) => b.start - a.start);
    let content = file.content;
    for (const e of edits) content = content.slice(0, e.start) + e.text + content.slice(e.end);
    applied.push(...accepted);
    return { path: file.path, content };
  });
  return { files: out, applied };
}
