import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { applyFixes, audit, isRelevant } from '../core/audit';
import { RULE_BY_ID, RULES, tierLabel } from '../core/rules';
import type { Finding, SourceFile } from '../core/types';
import { toSarif } from './sarif';

declare const __VERSION__: string;

const HELP = `duo-ready: audit an iPhone app for iPhone Duo and fix what can be fixed.

Usage
  duo-ready [path]                 Audit the project at path (default: .)
  duo-ready [path] --fix           Apply safe fixes in place
  duo-ready [path] --fix=all       Also apply fixes that need a human look
  duo-ready [path] --dry-run       Show what --fix would change, write nothing
  duo-ready rules                  List every rule and the Apple guidance behind it

Options
  --format text|json|sarif         Output format (default: text)
  --out <file>                     Write the report to a file
  --fail-on error|warning|never    Exit 1 at this severity (default: error)
  --no-color                       Plain output
`;

interface Options {
  path: string;
  fix: 'safe' | 'all' | null;
  dryRun: boolean;
  format: 'text' | 'json' | 'sarif';
  out: string | null;
  failOn: 'error' | 'warning' | 'never';
  color: boolean;
}

function parseArgs(argv: string[]): Options | 'help' | 'rules' | string {
  const o: Options = { path: '.', fix: null, dryRun: false, format: 'text', out: null, failOn: 'error', color: !process.env.NO_COLOR && !!process.stdout.isTTY };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '-h' || a === '--help') return 'help';
    else if (a === 'rules' && i === 0) return 'rules';
    else if (a === '--fix') o.fix = 'safe';
    else if (a === '--fix=all') o.fix = 'all';
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--no-color') o.color = false;
    else if (a === '--format' || a.startsWith('--format=')) {
      const v = value();
      if (v !== 'text' && v !== 'json' && v !== 'sarif') return `Unknown format "${v}"`;
      o.format = v;
    } else if (a === '--out' || a.startsWith('--out=')) o.out = value();
    else if (a === '--fail-on' || a.startsWith('--fail-on=')) {
      const v = value();
      if (v !== 'error' && v !== 'warning' && v !== 'never') return `Unknown --fail-on "${v}"`;
      o.failOn = v;
    } else if (a.startsWith('-')) return `Unknown option ${a}`;
    else o.path = a;
  }
  return o;
}

const MAX_BYTES = 2_000_000;

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
        if (!isRelevant(`${rel}/x.swift`)) continue;
        visit(full);
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

function textReport(result: ReturnType<typeof audit>, c: ReturnType<typeof paint>): string {
  const lines: string[] = [];
  const mark = { error: c.red('error'), warning: c.yellow('warn '), info: c.cyan('info ') };
  const byFile = new Map<string, Finding[]>();
  for (const f of result.findings) byFile.set(f.path, [...(byFile.get(f.path) ?? []), f]);
  for (const [path, findings] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(c.bold(path));
    for (const f of findings.sort((a, b) => a.line - b.line)) {
      const fix = f.fix ? c.green(f.fix.confidence === 'safe' ? ' [fixable]' : ' [fix: review]') : '';
      lines.push(`  ${c.dim(`${f.line}:${f.column}`.padEnd(7))} ${mark[f.severity]}  ${RULE_BY_ID.get(f.ruleId)!.title}${fix}`);
      lines.push(`  ${' '.repeat(7)}        ${c.dim(f.excerpt)}`);
      lines.push(`  ${' '.repeat(7)}        ${f.message}`);
    }
    lines.push('');
  }
  const count = (s: Finding['severity']) => result.findings.filter((f) => f.severity === s).length;
  const safe = result.findings.filter((f) => f.fix?.confidence === 'safe').length;
  const review = result.findings.filter((f) => f.fix?.confidence === 'review').length;
  lines.push(`${c.bold(`Duo readiness ${result.score}/100`)}  ${result.grade}`);
  lines.push(`${result.files} files scanned (${result.swiftFiles} Swift) · ${count('error')} errors · ${count('warning')} warnings · ${count('info')} notes`);
  if (result.tier) lines.push(`Today, Duo users likely see ${tierLabel(result.tier.value)} (based on ${result.tier.source}).`);
  if (safe || review) lines.push(`${safe} safe fixes (--fix), ${review} more for review (--fix=all).`);
  return lines.join('\n');
}

function diff(before: SourceFile[], after: SourceFile[]): string {
  const out: string[] = [];
  after.forEach((file, i) => {
    if (file.content === before[i].content) return;
    const a = before[i].content.split('\n');
    const b = file.content.split('\n');
    out.push(`--- ${file.path}`, `+++ ${file.path}`);
    // Fixes never reorder lines, so a prefix/suffix trim isolates each changed hunk well enough.
    let ai = 0;
    let bi = 0;
    while (ai < a.length || bi < b.length) {
      if (a[ai] === b[bi]) {
        ai++;
        bi++;
        continue;
      }
      const start = ai + 1;
      const removed: string[] = [];
      const added: string[] = [];
      const resync = () => {
        for (let look = 0; look < 5; look++) if (a[ai] !== undefined && a[ai] === b[bi + look]) return look;
        return -1;
      };
      let skip = resync();
      while (skip !== 0 && (ai < a.length || bi < b.length)) {
        if (skip > 0) {
          added.push(...b.slice(bi, bi + skip));
          bi += skip;
          break;
        }
        if (ai < a.length) removed.push(a[ai++]);
        if (bi < b.length) added.push(b[bi++]);
        skip = resync();
      }
      out.push(`@@ line ${start} @@`, ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`));
    }
  });
  return out.join('\n');
}

export function run(argv: string[], log = (s: string) => console.log(s)): number {
  let opts: ReturnType<typeof parseArgs>;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    log((e as Error).message);
    return 2;
  }
  if (opts === 'help') {
    log(HELP);
    return 0;
  }
  if (opts === 'rules') {
    for (const r of RULES) log(`${r.id.padEnd(26)} ${r.severity.padEnd(8)} ${r.title}\n${' '.repeat(36)}${r.instead}\n${' '.repeat(36)}${r.source}\n`);
    return 0;
  }
  if (typeof opts === 'string') {
    log(`${opts}\n\n${HELP}`);
    return 2;
  }
  const root = resolve(opts.path);
  let files: SourceFile[];
  try {
    files = readProject(root);
  } catch (e) {
    log((e as Error).message);
    return 2;
  }
  const c = paint(opts.color);
  if (files.length === 0) {
    log(`No Swift, Info.plist or Xcode project files found in ${root}.`);
    return 2;
  }
  let result = audit(files);

  if (opts.fix || opts.dryRun) {
    const { files: fixed, applied } = applyFixes(files, result.findings, opts.fix ?? 'safe');
    if (opts.dryRun) {
      log(diff(files, fixed) || 'Nothing to fix.');
      log(c.dim(`\n${applied.length} fixes would be applied. Nothing was written.`));
      return exitCode(result, opts.failOn);
    }
    fixed.forEach((file, i) => {
      if (file.content !== files[i].content) writeFileSync(join(statSync(root).isDirectory() ? root : resolve(root, '..'), file.path), file.content);
    });
    log(c.green(`Applied ${applied.length} fixes.`));
    result = audit(fixed);
  }

  const body =
    opts.format === 'json'
      ? JSON.stringify(result, null, 2)
      : opts.format === 'sarif'
        ? JSON.stringify(toSarif(result, __VERSION__, repoPrefix(root)), null, 2)
        : textReport(result, opts.out ? paint(false) : c);
  if (opts.out) {
    writeFileSync(opts.out, body + '\n');
    log(`Report written to ${opts.out}`);
  } else log(body);

  return exitCode(result, opts.failOn);
}

function exitCode(result: ReturnType<typeof audit>, failOn: Options['failOn']): number {
  if (failOn === 'never') return 0;
  return result.findings.some((f) => f.severity === 'error' || (failOn === 'warning' && f.severity === 'warning')) ? 1 : 0;
}

/** Path from the enclosing git checkout to the audited folder, so SARIF paths match the repo. */
function repoPrefix(root: string): string {
  const start = statSync(root).isDirectory() ? root : dirname(root);
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return relative(dir, start).split('\\').join('/');
    if (dirname(dir) === dir) return '';
  }
}
