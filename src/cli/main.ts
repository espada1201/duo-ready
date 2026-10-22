import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { applyFixes, audit, isRelevant, isRelevantDir, MAX_BYTES } from '../core/audit';
import { unifiedDiff } from '../core/diff';
import { describeCounts, PARTIAL_NOTE, screensFirst, summaryLine, unreadableNote } from '../core/findings';
import { RULE_BY_ID, RULES } from '../core/rules';
import { tierLabel } from '../core/sdk';
import { groupBy } from '../core/text';
import type { AuditResult, SourceFile } from '../core/types';
import { toSarif } from './sarif';

declare const __VERSION__: string;

const HELP = `duo-ready: audit an iPhone app for iPhone Duo and fix what can be fixed.

Usage
  duo-ready [path]                 Audit the project at path (default: .)
  duo-ready [path] --fix           Apply safe fixes in place
  duo-ready [path] --fix all       Also apply fixes that need a human look
  duo-ready [path] --dry-run       Show what --fix would change, write nothing
  duo-ready rules                  List every rule and the Apple guidance behind it

Options
  --format text|json|sarif         Output format (default: text)
  --out <file>                     Write the report to a file
  --fail-on error|warning|never    Exit 1 at this severity (default: error)
  --no-color                       Plain output
`;

interface AuditOptions {
  kind: 'audit';
  path: string;
  fix: 'safe' | 'all' | null;
  dryRun: boolean;
  format: 'text' | 'json' | 'sarif';
  out: string | null;
  failOn: 'error' | 'warning' | 'never';
  color: boolean;
}

type Command = AuditOptions | { kind: 'help' } | { kind: 'rules' } | { kind: 'error'; message: string };

const oneOf = <T extends string>(flag: string, v: string, allowed: readonly T[]): T => {
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`Unknown ${flag} "${v}"`);
  return v as T;
};

function parseArgs(argv: string[]): Command {
  const o: AuditOptions = { kind: 'audit', path: '.', fix: null, dryRun: false, format: 'text', out: null, failOn: 'error', color: !process.env.NO_COLOR && !!process.stdout.isTTY };
  let rules = false;
  let path: string | null = null;
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
      const value = () => {
        const v = inline ?? argv[++i];
        if (v === undefined) throw new Error(`${flag} needs a value`);
        return v;
      };
      if (a === '-h' || a === '--help') return { kind: 'help' };
      else if (flag === '--fix') {
        // `--fix`, `--fix=all` and `--fix all` all work; a bare `--fix` means safe fixes only.
        const level = inline ?? (argv[i + 1] === 'all' || argv[i + 1] === 'safe' ? argv[++i] : 'safe');
        o.fix = oneOf('--fix level', level, ['safe', 'all'] as const);
      } else if (a === '--dry-run') o.dryRun = true;
      else if (a === '--no-color') o.color = false;
      else if (flag === '--format') o.format = oneOf('format', value(), ['text', 'json', 'sarif'] as const);
      else if (flag === '--out') o.out = value();
      else if (flag === '--fail-on') o.failOn = oneOf('--fail-on', value(), ['error', 'warning', 'never'] as const);
      else if (a.startsWith('-')) return { kind: 'error', message: `Unknown option ${a}` };
      // `rules` is the subcommand unless there is a folder of that name to audit.
      else if (a === 'rules' && !existsSync(a)) rules = true;
      else if (path !== null) return { kind: 'error', message: `One project at a time: got "${path}" and "${a}"` };
      else path = a;
    }
  } catch (e) {
    return { kind: 'error', message: (e as Error).message };
  }
  return rules ? { kind: 'rules' } : { ...o, path: path ?? '.' };
}

function readProject(root: string): SourceFile[] {
  const out: SourceFile[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      // lstat: symlinked folders are skipped, so link cycles can't recurse forever.
      const st = lstatSync(full, { throwIfNoEntry: false });
      if (!st || st.isSymbolicLink()) continue;
      const rel = relative(root, full).split('\\').join('/');
      if (st.isDirectory()) {
        if (isRelevantDir(rel)) visit(full);
      } else if (st.size <= MAX_BYTES && isRelevant(rel)) out.push({ path: rel, content: readFileSync(full, 'utf8') });
    }
  };
  const st = statSync(root, { throwIfNoEntry: false });
  if (!st) throw new Error(`No such file or folder: ${root}`);
  if (st.isDirectory()) visit(root);
  else out.push({ path: root.split('/').pop()!, content: readFileSync(root, 'utf8') });
  return out;
}

function paint(on: boolean) {
  const wrap = (code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { red: wrap('31'), yellow: wrap('33'), cyan: wrap('36'), dim: wrap('2'), bold: wrap('1'), green: wrap('32') };
}

function textReport(result: AuditResult, c: ReturnType<typeof paint>): string {
  const lines: string[] = [];
  const mark = { error: c.red('error'), warning: c.yellow('warn '), info: c.cyan('info ') };
  for (const [path, findings] of [...groupBy(result.findings, (f) => f.path)].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(c.bold(path));
    for (const f of findings.sort((a, b) => a.line - b.line)) {
      const fix = f.fix ? c.green(f.fix.confidence === 'safe' ? ' [fixable]' : ' [fix: review]') : '';
      lines.push(`  ${c.dim(`${f.line}:${f.column}`.padEnd(7))} ${mark[f.severity]}  ${RULE_BY_ID.get(f.ruleId)!.title}${fix}`);
      lines.push(`  ${' '.repeat(7)}        ${c.dim(f.excerpt)}`);
      lines.push(`  ${' '.repeat(7)}        ${f.message}`);
    }
    lines.push('');
  }

  const screens = screensFirst(result.findings).slice(0, 3);
  if (screens.length) {
    lines.push(c.bold('Fix these screens first'));
    const width = Math.max(...screens.map((s) => s.screen.length));
    for (const s of screens) lines.push(`  ${s.screen.padEnd(width)}  ${describeCounts(s.findings)}  ${c.dim(s.path)}`);
    lines.push('');
  }

  const safe = result.findings.filter((f) => f.fix?.confidence === 'safe').length;
  const review = result.findings.filter((f) => f.fix?.confidence === 'review').length;
  lines.push(`${c.bold(`Duo readiness ${result.score}/100`)}  ${result.grade}`);
  lines.push(summaryLine(result));
  if (result.partial) lines.push(c.yellow(PARTIAL_NOTE));
  if (result.unreadable.length) lines.push(c.yellow(unreadableNote(result.unreadable)));
  if (result.tier) lines.push(`Today, Duo users likely see ${tierLabel(result.tier.value)} (based on ${result.tier.source}).`);
  if (safe || review) lines.push(`${safe} safe fixes (--fix), ${review} more for review (--fix all).`);
  return lines.join('\n');
}

/**
 * Runs the CLI. The report goes to `log` (stdout). Status lines go to `err` (stderr)
 * whenever stdout carries JSON or SARIF, so a piped report stays valid.
 */
export function run(argv: string[], log = (s: string) => console.log(s), err = (s: string) => console.error(s)): number {
  const cmd = parseArgs(argv);
  if (cmd.kind === 'help') {
    log(HELP);
    return 0;
  }
  if (cmd.kind === 'rules') {
    for (const r of RULES) log(`${r.id.padEnd(26)} ${r.severity.padEnd(8)} ${r.title}\n${' '.repeat(36)}${r.instead}\n${' '.repeat(36)}${r.source}\n`);
    return 0;
  }
  if (cmd.kind === 'error') {
    err(`${cmd.message}\n\n${HELP}`);
    return 2;
  }
  const status = cmd.format === 'text' ? log : err;
  const root = resolve(cmd.path);
  let files: SourceFile[];
  try {
    files = readProject(root);
  } catch (e) {
    err((e as Error).message);
    return 2;
  }
  const c = paint(cmd.color);
  if (files.length === 0) {
    err(`No Swift, Info.plist or Xcode project files found in ${root}.`);
    return 2;
  }
  let result = audit(files);

  if (cmd.fix || cmd.dryRun) {
    const { files: fixed, applied } = applyFixes(files, result.findings, cmd.fix ?? 'safe');
    if (cmd.dryRun) {
      const diff = files
        .map((file) => unifiedDiff(file.path, file.content, applied.filter((f) => f.path === file.path).flatMap((f) => f.fix!.edits)))
        .filter(Boolean)
        .join('\n');
      // With --format json or sarif the diff goes to stderr so stdout stays a valid report.
      status(diff || 'Nothing to fix.');
      status(c.dim(`\n${applied.length} fixes would be applied. Nothing was written.`));
      if (cmd.format === 'text' && !cmd.out) return exitCode(result, cmd.failOn);
    } else {
      const base = baseDir(root);
      try {
        fixed.forEach((file, i) => {
          if (file.content !== files[i].content) writeFileSync(join(base, file.path), file.content);
        });
      } catch (e) {
        err(`Could not write fixes: ${(e as Error).message}`);
        return 2;
      }
      status(c.green(`Applied ${applied.length} fixes.`));
      result = audit(fixed);
    }
  }

  const render: Record<AuditOptions['format'], () => string> = {
    json: () => JSON.stringify(result, null, 2),
    sarif: () => JSON.stringify(toSarif(result, __VERSION__, repoPrefix(root)), null, 2),
    text: () => textReport(result, cmd.out ? paint(false) : c),
  };
  const body = render[cmd.format]();
  if (cmd.out) {
    try {
      writeFileSync(cmd.out, body + '\n');
    } catch (e) {
      err(`Could not write the report: ${(e as Error).message}`);
      return 2;
    }
    status(`Report written to ${cmd.out}`);
  } else log(body);

  return exitCode(result, cmd.failOn);
}

function exitCode(result: AuditResult, failOn: AuditOptions['failOn']): number {
  if (failOn === 'never') return 0;
  return result.findings.some((f) => f.severity === 'error' || (failOn === 'warning' && f.severity === 'warning')) ? 1 : 0;
}

/** The folder that relative paths in the report start from. */
const baseDir = (root: string) => (statSync(root).isDirectory() ? root : dirname(root));

/** Path from the enclosing git checkout to the audited folder, so SARIF paths match the repo. */
function repoPrefix(root: string): string {
  const start = baseDir(root);
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return relative(dir, start).split('\\').join('/');
    if (dirname(dir) === dir) return '';
  }
}
