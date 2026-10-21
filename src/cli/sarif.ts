import { RULES } from '../core/rules';
import type { AuditResult } from '../core/types';

const LEVEL = { error: 'error', warning: 'warning', info: 'note' } as const;

/** SARIF 2.1.0, the format GitHub code scanning ingests. */
export function toSarif(result: AuditResult, version: string): object {
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'duo-ready',
            version,
            informationUri: 'https://github.com/espada1201/duo-ready',
            rules: RULES.map((r) => ({
              id: r.id,
              name: r.title,
              shortDescription: { text: r.title },
              fullDescription: { text: r.why },
              help: { text: `${r.instead} (${r.source})` },
              defaultConfiguration: { level: LEVEL[r.severity] },
            })),
          },
        },
        results: result.findings.map((f) => ({
          ruleId: f.ruleId,
          level: LEVEL[f.severity],
          message: { text: f.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.path },
                region: { startLine: f.line, startColumn: f.column },
              },
            },
          ],
        })),
      },
    ],
  };
}
