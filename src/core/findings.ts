// Shared ways of summarising findings, used by the CLI and the lab alike.

import { joinEnglish } from './text';
import type { AuditResult, Finding, Severity } from './types';

export const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
const PENALTY: Record<Severity, number> = { error: 8, warning: 3, info: 1 };

export const severityLabel = (s: Severity) => (s === 'info' ? 'note' : s);

export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const out = { error: 0, warning: 0, info: 0 };
  for (const f of findings) out[f.severity]++;
  return out;
}

/** What each grade means, for readers who see one without the scale. */
export const GRADE_LEGEND = '(Duo-ready 90+ with no errors, Close 70+, Needs work 40+, Not ready below)';

export const PARTIAL_NOTE = 'Partial audit: no Info.plist or Xcode project, so orientation, full-screen and SDK checks did not run. The grade is capped at Close.';

/** What to tell the reader about files that were found but couldn't be read. */
export const unreadableNote = (paths: string[]) =>
  `${joinEnglish(paths)} ${paths.length === 1 ? 'is a binary plist' : 'are binary plists'}, which duo-ready can't read. Convert with \`plutil -convert xml1 <file>\` to include ${paths.length === 1 ? 'it' : 'them'}.`;

/** " [safe fix]" or " [review fix]", the one name each kind of fix goes by. */
export const fixLabel = (f: Finding) => (f.fix ? ` [${f.fix.confidence} fix]` : '');

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

export function summaryLine(r: AuditResult): string {
  const n = countBySeverity(r.findings);
  return `${plural(r.files, 'file')} (${r.swiftFiles} Swift) · ${plural(n.error, 'error')} · ${plural(n.warning, 'warning')} · ${plural(n.info, 'note')}`;
}

/** Cost of a set of findings: each rule counts once, weighted by severity. The score is 100 minus this. */
export function cost(findings: Finding[]): number {
  const seen = new Map<string, Severity>();
  for (const f of findings) seen.set(f.ruleId, f.severity);
  let total = 0;
  for (const s of seen.values()) total += PENALTY[s];
  return total;
}

export interface ScreenSummary {
  /** The view or view controller, or the file name for findings outside any screen. */
  screen: string;
  path: string;
  findings: Finding[];
  cost: number;
  /** Points the score rises by once every finding here is fixed. A rule that also fires elsewhere adds nothing until it is fixed there too. */
  gain: number;
}

/** Screens, and files with findings outside any screen, ranked by the points fixing them gains. */
export function screensFirst(findings: Finding[]): ScreenSummary[] {
  const by = new Map<string, ScreenSummary>();
  for (const f of findings) {
    const screen = f.screen ?? f.path.slice(f.path.lastIndexOf('/') + 1);
    const key = f.screen ? `screen:${screen}` : `file:${f.path}`;
    const s = by.get(key) ?? { screen, path: f.path, findings: [], cost: 0, gain: 0 };
    s.findings.push(f);
    by.set(key, s);
  }
  const total = cost(findings);
  const out = [...by.values()];
  for (const s of out) {
    const mine = new Set(s.findings);
    s.cost = cost(s.findings);
    // The score bottoms out at 0, so a fix only gains the points that lift it above that.
    s.gain = Math.max(0, 100 - cost(findings.filter((f) => !mine.has(f)))) - Math.max(0, 100 - total);
  }
  return out.sort((a, b) => b.gain - a.gain || b.cost - a.cost || b.findings.length - a.findings.length || a.screen.localeCompare(b.screen));
}

/** "+5 points", or why fixing this alone doesn't move the score. */
export const gainLabel = (s: ScreenSummary) => (s.gain ? `+${plural(s.gain, 'point')}` : 'no points on its own');

export function describeCounts(findings: Finding[]): string {
  const n = countBySeverity(findings);
  const parts = [n.error && plural(n.error, 'error'), n.warning && plural(n.warning, 'warning'), n.info && plural(n.info, 'note')].filter(Boolean) as string[];
  return parts.join(', ');
}
