import type { PgType } from '../src/schema.js';
import type { SchemaSnapshot } from '../src/snapshot.js';

const dataTypes: Record<PgType, string> = {
  text: 'text',
  uuid: 'uuid',
  integer: 'integer',
  bigint: 'bigint',
  boolean: 'boolean',
  jsonb: 'jsonb',
  timestamptz: 'timestamp with time zone',
  date: 'date',
  numeric: 'numeric',
  'double precision': 'double precision',
};

export function expectedFrom(snapshot: SchemaSnapshot) {
  const rows: { table_name: string; column_name: string; data_type: string; is_nullable: string }[] = [];
  for (const table of Object.values(snapshot.tables)) {
    for (const col of Object.values(table.columns)) {
      rows.push({
        table_name: table.name,
        column_name: col.name,
        data_type: dataTypes[col.type],
        is_nullable: col.notNull ? 'NO' : 'YES',
      });
    }
  }
  return rows;
}

export function sorted<T extends { table_name: string }>(rows: T[]): T[] {
  const names = [...new Set(rows.map((r) => r.table_name))].sort();
  return names.flatMap((n) => rows.filter((r) => r.table_name === n));
}

const deleteActions: Record<string, string> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};

export function onDeleteFromCode(code: string): string {
  return deleteActions[code] ?? code;
}

export function expectedIndexes(snapshot: SchemaSnapshot) {
  return Object.values(snapshot.tables)
    .flatMap((t) => Object.values(t.indexes).map((i) => ({ table_name: t.name, index_name: i.name, unique: i.unique })))
    .sort((a, b) => a.index_name.localeCompare(b.index_name));
}

export function expectedForeignKeys(snapshot: SchemaSnapshot) {
  return Object.values(snapshot.tables)
    .flatMap((t) =>
      Object.values(t.foreignKeys).map((fk) => ({
        table_name: t.name,
        constraint_name: fk.name,
        ref_table: fk.refTable,
        on_delete: fk.onDelete ?? 'NO ACTION',
      })),
    )
    .sort((a, b) => a.constraint_name.localeCompare(b.constraint_name));
}

export function expectedTriggers(snapshot: SchemaSnapshot) {
  return Object.values(snapshot.tables)
    .flatMap((t) => Object.values(t.triggers).map((trg) => ({ table_name: t.name, trigger_name: trg.name })))
    .sort((a, b) => a.trigger_name.localeCompare(b.trigger_name));
}
