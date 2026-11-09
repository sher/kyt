import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { KytPgConfig } from './config.js';
import { applyRenames, diffSnapshots, findRenameCandidates } from './diff.js';
import type { Rename } from './diff.js';
import { generateDiffName, generateMigrationPrefix, toSnake } from './naming.js';
import { diffToSQL, diffToValidateSQL } from './sql.js';
import { EMPTY_SNAPSHOT, serializeSchema } from './snapshot.js';
import type { SchemaSnapshot } from './snapshot.js';

export interface CliIO {
  cwd: string;
  isTTY: boolean;
  ask(question: string): Promise<boolean>;
  log(line: string): void;
  error(line: string): void;
}

const CONFIG_FILE = 'config.ts';
const SCHEMA_FILE = 'schema.ts';
const SNAPSHOT_FILE = 'schema.json';
const SCHEMA_SQL_FILE = 'schema.sql';
const DEFAULT_DIR = 'db';

const NO_TERMINAL_ERROR =
  'Error: schema:diff found possible renames and cannot ask without a terminal. Run it in a terminal, or pass --rename <Table>.<old>=<new> for each rename, or pass --no-rename.';

const SCHEMA_TEMPLATE = `import { createQueryBuilder } from 'kyt-pg';
import type { InferDB } from 'kyt-pg';

// Define your tables here, then run: kyt-pg schema:diff <name>
//
// import { defineTable, defineIndex, withDefault } from 'kyt-pg';
// import * as v from 'valibot';
//
// export const User = defineTable('User', {
//   email: v.string(),
//   fullName: v.nullable(v.string()),
//   isActive: withDefault(v.boolean(), true),
// });
//
// export const UserEmailIdx = defineIndex(User, ['email'], { unique: true });

export type DB = InferDB<{
  // User: typeof User;
}>;

export const db = createQueryBuilder<DB>();
`;

export function parseRenameFlag(value: string): Rename {
  const invalid = new Error('kyt-pg: --rename takes <Table>=<NewTable> or <Table>.<old>=<new>');
  const parts = value.split('=');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalid;
  const [left, to] = parts;
  const dot = left.split('.');
  if (dot.length === 1) return { kind: 'table', from: left, to };
  if (dot.length === 2 && dot[0] && dot[1]) return { kind: 'column', table: dot[0], from: dot[1], to };
  throw invalid;
}

function sameRename(a: Rename, b: Rename): boolean {
  if (a.kind === 'table' && b.kind === 'table') return a.from === b.from && a.to === b.to;
  if (a.kind === 'column' && b.kind === 'column') {
    return a.table === b.table && a.from === b.from && a.to === b.to;
  }
  return false;
}

function renameFlagText(r: Rename): string {
  return r.kind === 'table' ? `${r.from}=${r.to}` : `${r.table}.${r.from}=${r.to}`;
}

function findDir(io: CliIO, dirFlag?: string): string | null {
  const dir = resolve(io.cwd, dirFlag ?? DEFAULT_DIR);
  return existsSync(join(dir, CONFIG_FILE)) ? dir : null;
}

export function cmdInit(io: CliIO, opts: { dir?: string }): void {
  const dir = resolve(io.cwd, opts.dir ?? DEFAULT_DIR);
  const relDir = relative(io.cwd, dir) || '.';

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    io.log(`Created: ${relDir}/`);
  }

  const files: Array<[string, string]> = [
    [
      CONFIG_FILE,
      `import { defineConfig } from 'kyt-pg';\n\nexport default defineConfig({\n  migrationsDir: 'db/migrations',\n  namingStrategy: 'sequential',\n});\n`,
    ],
    [SCHEMA_FILE, SCHEMA_TEMPLATE],
    [SNAPSHOT_FILE, JSON.stringify(EMPTY_SNAPSHOT, null, 2) + '\n'],
  ];

  for (const [file, content] of files) {
    const path = join(dir, file);
    if (existsSync(path)) {
      io.log(`Skipped: ${relDir}/${file} (already exists)`);
      continue;
    }
    writeFileSync(path, content);
    io.log(`Created: ${relDir}/${file}`);
  }

  io.log('');
  io.log('Next steps:');
  io.log(`  1. Change: ${relDir}/${SCHEMA_FILE}`);
  io.log('  2. Run:    kyt-pg schema:diff <name>');
}

async function chooseRenames(
  io: CliIO,
  candidates: Rename[],
  flagged: Rename[],
  noRename: boolean,
): Promise<Rename[] | null> {
  const accepted: Rename[] = [];
  const used = new Set<string>();
  for (const candidate of candidates) {
    const scope = candidate.kind === 'table' ? '' : `${candidate.table}.`;
    const fromKey = `${scope}${candidate.from}`;
    const toKey = `${scope}${candidate.to}`;
    if (used.has(fromKey) || used.has(toKey)) continue;

    let isRename = flagged.some((f) => sameRename(f, candidate));
    if (!isRename && !noRename) {
      if (!io.isTTY) {
        io.error(NO_TERMINAL_ERROR);
        return null;
      }
      const question =
        candidate.kind === 'table'
          ? `Is table "${candidate.to}" a rename of "${candidate.from}"? (y/N)`
          : `Is column "${candidate.table}"."${candidate.to}" a rename of "${candidate.table}"."${candidate.from}"? (y/N)`;
      isRename = await io.ask(question);
    }
    if (isRename) {
      accepted.push(candidate);
      used.add(fromKey);
      used.add(toKey);
    }
  }
  return accepted;
}

export async function cmdSchemaDiff(
  io: CliIO,
  opts: { name?: string; dir?: string; schema?: string; renames: Rename[]; noRename: boolean },
): Promise<number> {
  const dir = findDir(io, opts.dir);
  if (!dir) {
    io.error('Error: kyt-pg is not set up. Run "kyt-pg init" first.');
    if (opts.dir) io.error(`       (looked in: ${opts.dir})`);
    return 1;
  }

  let config: KytPgConfig;
  try {
    const mod = await import(pathToFileURL(join(dir, CONFIG_FILE)).href);
    config = mod.default ?? mod.config;
  } catch (err) {
    io.error(`Error: Could not load config from ${join(dir, CONFIG_FILE)}: ${(err as Error).message}`);
    return 1;
  }
  if (!config) {
    io.error(`Error: Could not load config from ${join(dir, CONFIG_FILE)}`);
    return 1;
  }

  const schemaPath = opts.schema ? resolve(io.cwd, opts.schema) : join(dir, SCHEMA_FILE);
  if (!existsSync(schemaPath)) {
    io.error(`Error: Schema file not found: ${schemaPath}`);
    return 1;
  }

  let schemaExports: Record<string, unknown>;
  try {
    schemaExports = await import(pathToFileURL(schemaPath).href);
  } catch (err) {
    io.error(`Error loading schema from ${schemaPath}: ${(err as Error).message}`);
    return 1;
  }

  const next = serializeSchema(schemaExports);

  const snapshotPath = join(dir, SNAPSHOT_FILE);
  let prev: SchemaSnapshot = EMPTY_SNAPSHOT;
  if (existsSync(snapshotPath)) {
    try {
      prev = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as SchemaSnapshot;
    } catch {
      io.error(`Error: Could not read ${snapshotPath}.`);
      return 1;
    }
  }
  if (Object.keys(prev.tables ?? {}).length > 0 && prev.dialect !== 'postgres') {
    io.error('Error: schema.json is not a kyt-pg snapshot.');
    return 1;
  }

  const tableCandidates = findRenameCandidates(diffSnapshots(prev, next)).filter(
    (r) => r.kind === 'table',
  );
  const tableRenames = await chooseRenames(io, tableCandidates, opts.renames, opts.noRename);
  if (!tableRenames) return 1;

  const afterTables = applyRenames(prev, tableRenames);
  const columnCandidates = findRenameCandidates(diffSnapshots(afterTables, next)).filter(
    (r) => r.kind === 'column',
  );
  const columnRenames = await chooseRenames(io, columnCandidates, opts.renames, opts.noRename);
  if (!columnRenames) return 1;

  const renames = [...tableRenames, ...columnRenames];
  const unmatched = opts.renames.filter((flag) => !renames.some((r) => sameRename(r, flag)));
  if (unmatched.length > 0) {
    for (const flag of unmatched) {
      io.error(`Error: --rename ${renameFlagText(flag)} matches no possible rename. Check the names and run schema:diff again.`);
    }
    return 1;
  }
  const diff = diffSnapshots(applyRenames(prev, renames), next);
  const statements = diffToSQL(diff, renames);

  if (statements.length === 0) {
    io.log('Schema is up to date.');
    return 0;
  }

  const outDir = resolve(io.cwd, config.migrationsDir);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const prefix = generateMigrationPrefix(config.namingStrategy ?? 'sequential', readdirSync(outDir));
  const snakeName = opts.name ? toSnake(opts.name) : generateDiffName(diff);
  const filename = `${prefix}_${snakeName}.sql`;
  const sql =
    `-- Generated by kyt-pg schema:diff\n` +
    `-- ${new Date().toISOString()}\n\n` +
    `${statements.join('\n\n')}\n`;
  writeFileSync(join(outDir, filename), sql);
  io.log(`Created: ${config.migrationsDir}/${filename}`);

  const validateStatements = diffToValidateSQL(diff);
  if (validateStatements.length > 0) {
    const validatePrefix = generateMigrationPrefix(config.namingStrategy ?? 'sequential', readdirSync(outDir));
    const validateName = `${validatePrefix}_${snakeName}_validate.sql`;
    writeFileSync(
      join(outDir, validateName),
      `-- Generated by kyt-pg schema:diff\n` +
        `-- Checks the old rows against the new checks from ${filename}, without blocking writes.\n\n` +
        `${validateStatements.join('\n\n')}\n`,
    );
    io.log(`Created: ${config.migrationsDir}/${validateName}`);
  }

  const relDir = relative(io.cwd, dir) || '.';
  writeFileSync(snapshotPath, JSON.stringify(next, null, 2) + '\n');
  io.log(`Changed: ${relDir}/${SNAPSHOT_FILE}`);

  const fullStatements = diffToSQL(diffSnapshots(EMPTY_SNAPSHOT, next));
  const schemaSql =
    `-- Generated by kyt-pg schema:diff\n` +
    `-- Full schema as of: ${new Date().toISOString()}\n\n` +
    `${fullStatements.join('\n\n')}\n`;
  writeFileSync(join(dir, SCHEMA_SQL_FILE), schemaSql);
  io.log(`Changed: ${relDir}/${SCHEMA_SQL_FILE}`);

  io.log('');
  io.log('Next: review the file, then run your migration job.');
  return 0;
}
