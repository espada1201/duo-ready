export type Severity = 'error' | 'warning' | 'info';

export interface SourceFile {
  path: string;
  content: string;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

export interface Fix {
  /** `safe` fixes are applied by `--fix`; `review` fixes need `--fix=all` or a click in the lab. */
  confidence: 'safe' | 'review';
  description: string;
  edits: Edit[];
}

export interface Finding {
  ruleId: string;
  severity: Severity;
  path: string;
  line: number;
  column: number;
  message: string;
  /** The offending source line, trimmed, for reports. */
  excerpt: string;
  /** The SwiftUI view or UIKit view controller the finding is in, when there is one. */
  screen?: string;
  fix?: Fix;
}

export type SdkTier = '26' | '27' | '27.1';

export interface AuditResult {
  files: number;
  swiftFiles: number;
  findings: Finding[];
  score: number;
  grade: 'Duo-ready' | 'Close' | 'Needs work' | 'Not ready';
  /** Best guess of what Duo users see today, from the Xcode version the project was last upgraded with. */
  tier: { value: SdkTier; source: string } | null;
  /** No Info.plist or Xcode project was given, so project-level checks did not run and the grade is capped. */
  partial: boolean;
}
