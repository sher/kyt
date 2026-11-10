import type { PgType, SchemaCheck, SchemaForeignKey, SchemaTable, TableOptions } from './schema.js';
import { pgTypeFromSchema } from './schema.js';

export interface ColumnSnapshot {
  name: string;
  type: PgType;
  notNull: boolean;
  primaryKey?: true;
  identity?: true;
  default?: string;
  check?: CheckSnapshot;
}

export interface CheckSnapshot {
  name: string;
  values: (string | number)[];
}

export interface TableCheckSnapshot {
  name: string;
  sql: string;
}

export interface IndexSnapshot {
  name: string;
  columns: string[];
  unique: boolean;
  where?: string;
}

export interface TriggerSnapshot {
  name: string;
  timing: string;
  event: string;
  tableName: string;
  body: string;
  function?: string;
}

export interface ForeignKeySnapshot {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete?: string;
  onUpdate?: string;
  deferrable?: 'immediate' | 'deferred';
}

export interface TableSnapshot {
  name: string;
  columns: Record<string, ColumnSnapshot>;
  indexes: Record<string, IndexSnapshot>;
  triggers: Record<string, TriggerSnapshot>;
  foreignKeys: Record<string, ForeignKeySnapshot>;
  checks?: Record<string, TableCheckSnapshot>;
}

export interface SchemaSnapshot {
  version: 1;
  dialect: 'postgres';
  tables: Record<string, TableSnapshot>;
}

export const EMPTY_SNAPSHOT: SchemaSnapshot = { version: 1, dialect: 'postgres', tables: {} };

function isSchemaTable(val: unknown): val is SchemaTable {
  return (
    typeof val === 'object' &&
    val !== null &&
    (val as Record<string, unknown>)._schemaTable === true
  );
}

const defaultOpts = {
  primaryKey: true,
  id: 'bigint',
  createdAt: true,
  updatedAt: true,
  primaryKeyColumn: 'id',
  createdAtColumn: 'createdAt',
  updatedAtColumn: 'updatedAt',
} as const;

function idColumn(name: string, id: 'bigint' | 'integer' | 'uuid'): ColumnSnapshot {
  if (id === 'uuid') {
    return { name, type: 'uuid', notNull: true, primaryKey: true, default: 'gen_random_uuid()' };
  }
  return { name, type: id, notNull: true, primaryKey: true, identity: true };
}

export function serializeSchema(exports: Record<string, unknown>): SchemaSnapshot {
  const tables: Record<string, TableSnapshot> = {};

  const defined = Object.values(exports)
    .filter(isSchemaTable)
    .sort((a, b) => a._order - b._order);

  for (const table of defined) {
    const opts = { ...defaultOpts, ...((table._options ?? {}) as TableOptions) };

    const columns: Record<string, ColumnSnapshot> = {};

    if (opts.primaryKey) {
      columns[opts.primaryKeyColumn] = idColumn(opts.primaryKeyColumn, opts.id);
    }

    for (const [colName, colSchema] of Object.entries(table._columns)) {
      const info = pgTypeFromSchema(colSchema);
      const col: ColumnSnapshot = { name: colName, type: info.type, notNull: info.notNull };
      if (info.default !== undefined) col.default = info.default;
      if (info.values) col.check = { name: `${table._name}_${colName}_check`, values: info.values };
      columns[colName] = col;
    }

    if (opts.createdAt) {
      columns[opts.createdAtColumn] = {
        name: opts.createdAtColumn,
        type: 'timestamptz',
        notNull: true,
        default: 'now()',
      };
    }

    if (opts.updatedAt) {
      columns[opts.updatedAtColumn] = {
        name: opts.updatedAtColumn,
        type: 'timestamptz',
        notNull: true,
        default: 'now()',
      };
    }

    const indexes: Record<string, IndexSnapshot> = {};
    for (const idx of table._indexes) {
      const snap: IndexSnapshot = { name: idx.name, columns: [...idx.columns], unique: idx.unique };
      if (idx.where !== undefined) snap.where = idx.where;
      indexes[idx.name] = snap;
    }

    const foreignKeys: Record<string, ForeignKeySnapshot> = {};
    for (const fk of (table._foreignKeys ?? []) as SchemaForeignKey[]) {
      const refOpts = { ...defaultOpts, ...((fk.references._options ?? {}) as TableOptions) };
      const refPk = refOpts.primaryKey ? refOpts.primaryKeyColumn : undefined;
      const refColumns = [...(fk.refColumns ?? (refPk ? [refPk] : []))];
      if (refColumns.length === 0) continue;
      const snap: ForeignKeySnapshot = {
        name: `${table._name}_${fk.columns.join('_')}_fkey`,
        columns: [...fk.columns],
        refTable: fk.references._name,
        refColumns,
      };
      if (fk.onDelete) snap.onDelete = fk.onDelete;
      if (fk.onUpdate) snap.onUpdate = fk.onUpdate;
      if (fk.deferrable) snap.deferrable = fk.deferrable;
      foreignKeys[fk.columns.join(',')] = snap;
    }

    const triggers: Record<string, TriggerSnapshot> = {};
    if (opts.updatedAt) {
      const name = `${table._name}_${opts.updatedAtColumn}_trg`;
      triggers[name] = {
        name,
        timing: 'BEFORE',
        event: 'UPDATE',
        tableName: table._name,
        body: `NEW."${opts.updatedAtColumn}" = now();`,
        function: `kyt_set_${opts.updatedAtColumn}`,
      };
    }

    for (const trg of table._triggers) {
      triggers[trg.name] = {
        name: trg.name,
        timing: trg.timing,
        event: trg.event,
        tableName: trg.tableName,
        body: trg.body,
      };
    }

    const checks: Record<string, TableCheckSnapshot> = {};
    const columnChecks = new Set(Object.values(columns).flatMap((c) => (c.check ? [c.check.name] : [])));
    for (const check of (table._checks ?? []) as SchemaCheck[]) {
      if (checks[check.name] || columnChecks.has(check.name)) {
        throw new Error(`kyt-pg: table "${table._name}" has two checks named "${check.name}"`);
      }
      checks[check.name] = { name: check.name, sql: check.sql };
    }

    tables[table._name] = { name: table._name, columns, indexes, triggers, foreignKeys, checks };
  }

  return { version: 1, dialect: 'postgres', tables };
}
