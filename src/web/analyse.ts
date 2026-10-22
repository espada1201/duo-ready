// The audit and its fix previews, shared by the page and the worker that runs it off the main thread.

import { audit } from '../core/audit';
import { hunks, type Hunk } from '../core/diff';
import type { AuditResult, SourceFile } from '../core/types';

export interface Analysis {
  result: AuditResult;
  /** The diff each fix makes, by finding index. */
  previews: Map<number, Hunk[]>;
}

export function analyse(files: SourceFile[]): Analysis {
  const result = audit(files);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const previews = new Map<number, Hunk[]>();
  result.findings.forEach((f, i) => {
    if (f.fix) previews.set(i, hunks(byPath.get(f.path)!.content, f.fix.edits));
  });
  return { result, previews };
}
