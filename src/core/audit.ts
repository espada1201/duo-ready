import { checkFiles, RULE_BY_ID, tierFromUpgradeCheck, xcodeVersion } from './rules';
import type { AuditResult, Finding, SourceFile } from './types';

const SKIP_DIR = /(^|\/)(Pods|Carthage|DerivedData|node_modules|build|SourcePackages|\.[^/]+)\//;
const RELEVANT = /(\.swift|\.plist|\/project\.pbxproj|(^|\/)package\.json|(^|\/)pubspec\.yaml)$/;

export function isRelevant(path: string): boolean {
  return RELEVANT.test(path) && !SKIP_DIR.test(path);
}

const PENALTY = { error: 8, warning: 3, info: 1 } as const;
/** Each rule costs once however often it fires: the score measures kinds of problem, not volume. */
const MAX_HITS_PER_RULE = 1;

function score(findings: Finding[]): number {
  const hits = new Map<string, number>();
  for (const f of findings) hits.set(f.ruleId, (hits.get(f.ruleId) ?? 0) + 1);
  let total = 0;
  for (const [id, n] of hits) total += PENALTY[RULE_BY_ID.get(id)!.severity] * Math.min(n, MAX_HITS_PER_RULE);
  return Math.max(0, 100 - total);
}

function grade(value: number, findings: Finding[]): AuditResult['grade'] {
  const errors = findings.some((f) => f.severity === 'error');
  if (value >= 90 && !errors) return 'Duo-ready';
  if (value >= 70) return 'Close';
  if (value >= 40) return 'Needs work';
  return 'Not ready';
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

export function audit(input: SourceFile[]): AuditResult {
  const files = input.filter((f) => isRelevant(f.path));
  const findings = checkFiles(files).sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column,
  );
  const value = score(findings);
  let tier: AuditResult['tier'] = null;
  for (const f of files) {
    const check = f.path.endsWith('project.pbxproj') && /LastUpgradeCheck\s*=\s*(\d{4});/.exec(f.content);
    if (check) {
      tier = { value: tierFromUpgradeCheck(check[1]), source: `LastUpgradeCheck ${check[1]}, Xcode ${xcodeVersion(check[1])}` };
      break;
    }
  }
  return {
    files: files.length,
    swiftFiles: files.filter((f) => f.path.endsWith('.swift')).length,
    findings,
    score: value,
    grade: grade(value, findings),
    tier,
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
