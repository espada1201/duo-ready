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

export const PARTIAL_NOTE = 'Partial audit: no Info.plist or Xcode project, so orientation, full-screen and SDK checks did not run. The grade is capped at Close.';

/** What to tell the reader about files that were found but couldn't be read. */
export const unreadableNote = (paths: string[]) =>
  `${joinEnglish(paths)} ${paths.length === 1 ? 'is a binary plist' : 'are binary plists'}, which duo-ready can't read. Convert with \`plutil -convert xml1 <file>\` to include ${paths.length === 1 ? 'it' : 'them'}.`;

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

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
  screen: string;
  path: string;
  findings: Finding[];
  cost: number;
}

/** Screens ranked by how much fixing them would raise the score, worst first. */
export function screensFirst(findings: Finding[]): ScreenSummary[] {
  const by = new Map<string, ScreenSummary>();
  for (const f of findings) {
    if (!f.screen) continue;
    const s = by.get(f.screen) ?? { screen: f.screen, path: f.path, findings: [], cost: 0 };
    s.findings.push(f);
    by.set(f.screen, s);
  }
  const out = [...by.values()];
  for (const s of out) s.cost = cost(s.findings);
  return out.sort((a, b) => b.cost - a.cost || b.findings.length - a.findings.length || a.screen.localeCompare(b.screen));
}

export function describeCounts(findings: Finding[]): string {
  const n = countBySeverity(findings);
  const parts = [n.error && plural(n.error, 'error'), n.warning && plural(n.warning, 'warning'), n.info && plural(n.info, 'note')].filter(Boolean) as string[];
  return parts.join(', ');
}
