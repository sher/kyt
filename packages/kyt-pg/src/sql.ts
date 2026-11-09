import type { Rename, SchemaDiff, TableChange } from './diff.js';
import type {
  CheckSnapshot,
  ColumnSnapshot,
  ForeignKeySnapshot,
  IndexSnapshot,
  TableSnapshot,
  TriggerSnapshot,
} from './snapshot.js';

function q(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function columnSql(col: ColumnSnapshot): string {
  if (col.primaryKey) {
    if (col.identity) return `${q(col.name)} ${col.type} GENERATED ALWAYS AS IDENTITY PRIMARY KEY`;
    const def = col.default !== undefined ? ` DEFAULT ${col.default}` : '';
    return `${q(col.name)} ${col.type} PRIMARY KEY${def}`;
  }
  const notNull = col.notNull ? ' NOT NULL' : '';
  const def = col.default !== undefined ? ` DEFAULT ${col.default}` : '';
  const check = col.check ? ` CONSTRAINT ${q(col.check.name)} ${checkSql(col.name, col.check)}` : '';
  return `${q(col.name)} ${col.type}${notNull}${def}${check}`;
}

function literal(value: string | number): string {
  return typeof value === 'number' ? String(value) : `'${value.replaceAll("'", "''")}'`;
}

function checkSql(column: string, check: CheckSnapshot): string {
  return `CHECK (${q(column)} IN (${check.values.map(literal).join(', ')}))`;
}

function checkChangeSql(table: string, column: string, before: CheckSnapshot | undefined, after: CheckSnapshot | undefined, out: string[]): void {
  const alter = `ALTER TABLE ${q(table)}`;
  if (!before && !after) return;
  if (before && after && JSON.stringify(before.values) === JSON.stringify(after.values)) {
    if (before.name !== after.name) out.push(`${alter} RENAME CONSTRAINT ${q(before.name)} TO ${q(after.name)};`);
    return;
  }
  if (before) out.push(`${alter} DROP CONSTRAINT IF EXISTS ${q(before.name)};`);
  if (after) out.push(`${alter} ADD CONSTRAINT ${q(after.name)} ${checkSql(column, after)} NOT VALID;`);
}

export function diffToValidateSQL(diff: SchemaDiff): string[] {
  const out: string[] = [];
  for (const change of diff.changedTables) {
    for (const { name, before, after } of change.columns) {
      if (!before || !after?.check) continue;
      if (before.check && JSON.stringify(before.check.values) === JSON.stringify(after.check.values)) continue;
      const removed = before.check ? before.check.values.filter((value) => !after.check!.values.includes(value)) : undefined;
      if (!removed || removed.length > 0) {
        out.push(
          `-- WARNING: limits "${change.name}"."${name}" to ${after.check.values.map(literal).join(', ')}. This fails if any row holds another value. Change those rows first.`,
        );
      }
      out.push(`ALTER TABLE ${q(change.name)} VALIDATE CONSTRAINT ${q(after.check.name)};`);
    }
  }
  return out;
}

function createTableSql(table: TableSnapshot): string {
  const cols = Object.values(table.columns).map((c) => `  ${columnSql(c)}`);
  return `CREATE TABLE ${q(table.name)} (\n${cols.join(',\n')}\n);`;
}

function createIndexSql(table: string, idx: IndexSnapshot): string {
  const unique = idx.unique ? 'UNIQUE ' : '';
  const cols = idx.columns.map(q).join(', ');
  const where = idx.where !== undefined ? ` WHERE ${idx.where}` : '';
  return `CREATE ${unique}INDEX ${q(idx.name)} ON ${q(table)} (${cols})${where};`;
}

function sameForeignKey(a: ForeignKeySnapshot, b: ForeignKeySnapshot): boolean {
  const { name: _a, deferrable: _da, ...restA } = a;
  const { name: _b, deferrable: _db, ...restB } = b;
  return JSON.stringify(restA) === JSON.stringify(restB);
}

function deferrableSql(deferrable: ForeignKeySnapshot['deferrable']): string {
  if (deferrable === 'deferred') return 'DEFERRABLE INITIALLY DEFERRED';
  if (deferrable === 'immediate') return 'DEFERRABLE INITIALLY IMMEDIATE';
  return 'NOT DEFERRABLE';
}

function addForeignKeySql(table: string, fk: ForeignKeySnapshot): string {
  const onDelete = fk.onDelete ? ` ON DELETE ${fk.onDelete}` : '';
  const onUpdate = fk.onUpdate ? ` ON UPDATE ${fk.onUpdate}` : '';
  const deferrable = fk.deferrable ? ` ${deferrableSql(fk.deferrable)}` : '';
  return (
    `ALTER TABLE ${q(table)} ADD CONSTRAINT ${q(fk.name)} ` +
    `FOREIGN KEY (${fk.columns.map(q).join(', ')}) ` +
    `REFERENCES ${q(fk.refTable)}(${fk.refColumns.map(q).join(', ')})${onDelete}${onUpdate}${deferrable};`
  );
}

function dropForeignKeySql(table: string, fk: ForeignKeySnapshot): string {
  return `ALTER TABLE ${q(table)} DROP CONSTRAINT ${q(fk.name)};`;
}

function createTriggerSql(trigger: TriggerSnapshot, table: string, created: Set<string>): string[] {
  const ret = trigger.event === 'DELETE' ? 'OLD' : 'NEW';
  const name = trigger.function ?? `${trigger.name}_fn`;
  const fn = q(name);
  const out: string[] = [];
  if (!created.has(name)) {
    created.add(name);
    out.push(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n  ${trigger.body}\n  RETURN ${ret};\nEND $$;`);
  }
  out.push(`CREATE TRIGGER ${q(trigger.name)} ${trigger.timing} ${trigger.event} ON ${q(table)} FOR EACH ROW EXECUTE FUNCTION ${fn}();`);
  return out;
}

function dropTriggerSql(trigger: TriggerSnapshot, table: string): string[] {
  const out = [`DROP TRIGGER IF EXISTS ${q(trigger.name)} ON ${q(table)};`];
  if (!trigger.function) out.push(`DROP FUNCTION IF EXISTS ${q(`${trigger.name}_fn`)}();`);
  return out;
}

function columnChangeSql(change: TableChange, out: string[]): void {
  const t = change.name;
  const alter = `ALTER TABLE ${q(t)}`;
  let primaryKeyWarned = false;
  for (const { name, before, after } of change.columns) {
    if (!before && after) {
      if (after.notNull && after.default === undefined && !after.identity) {
        out.push(
          `-- WARNING: adds NOT NULL column "${t}"."${name}" with no default. This fails if the table has rows. Add a default, or add the column as nullable and fill it first.`,
        );
      }
      out.push(`${alter} ADD COLUMN ${columnSql(after)};`);
    } else if (before && !after) {
      out.push(
        `-- WARNING: drops column "${t}"."${name}" and its data. If this is a rename, run schema:diff again and answer yes.`,
      );
      out.push(`${alter} DROP COLUMN ${q(name)};`);
    } else if (before && after) {
      const keyChanged = Boolean(before.primaryKey) !== Boolean(after.primaryKey) || Boolean(before.identity) !== Boolean(after.identity);
      if (keyChanged) {
        if (!primaryKeyWarned) {
          primaryKeyWarned = true;
          out.push(
            `-- WARNING: the primary key of "${t}" changed. kyt-pg does not write this change. Write it by hand.`,
          );
        }
        continue;
      }
      if (before.type !== after.type) {
        out.push(
          `-- WARNING: changes "${t}"."${name}" from ${before.type} to ${after.type}. This fails if any row cannot be cast. Change the USING part if needed.`,
        );
        out.push(
          `${alter} ALTER COLUMN ${q(name)} TYPE ${after.type} USING ${q(name)}::${after.type};`,
        );
      }
      if (!before.notNull && after.notNull) {
        out.push(
          `-- WARNING: makes "${t}"."${name}" NOT NULL. This fails if any row holds NULL. Fill those rows first.`,
        );
        out.push(`${alter} ALTER COLUMN ${q(name)} SET NOT NULL;`);
      } else if (before.notNull && !after.notNull) {
        out.push(`${alter} ALTER COLUMN ${q(name)} DROP NOT NULL;`);
      }
      if (before.default !== after.default) {
        out.push(
          after.default !== undefined
            ? `${alter} ALTER COLUMN ${q(name)} SET DEFAULT ${after.default};`
            : `${alter} ALTER COLUMN ${q(name)} DROP DEFAULT;`,
        );
      }
      checkChangeSql(t, name, before.check, after.check, out);
    }
  }
}

export function diffToSQL(diff: SchemaDiff, renames: Rename[] = []): string[] {
  const out: string[] = [];

  for (const r of renames) {
    out.push(
      r.kind === 'table'
        ? `ALTER TABLE ${q(r.from)} RENAME TO ${q(r.to)};`
        : `ALTER TABLE ${q(r.table)} RENAME COLUMN ${q(r.from)} TO ${q(r.to)};`,
    );
  }

  for (const table of diff.addedTables) {
    out.push(createTableSql(table));
    for (const idx of Object.values(table.indexes)) out.push(createIndexSql(table.name, idx));
  }

  for (const change of diff.changedTables) {
    for (const fk of change.foreignKeys) {
      if (!fk.before) continue;
      if (fk.after && sameForeignKey(fk.before, fk.after)) {
        if (fk.before.name !== fk.after.name) {
          out.push(
            `ALTER TABLE ${q(change.name)} RENAME CONSTRAINT ${q(fk.before.name)} TO ${q(fk.after.name)};`,
          );
        }
        if (fk.before.deferrable !== fk.after.deferrable) {
          out.push(`ALTER TABLE ${q(change.name)} ALTER CONSTRAINT ${q(fk.after.name)} ${deferrableSql(fk.after.deferrable)};`);
        }
      } else {
        out.push(dropForeignKeySql(change.name, fk.before));
      }
    }
    columnChangeSql(change, out);
    for (const idx of change.indexes) {
      if (idx.before) out.push(`DROP INDEX IF EXISTS ${q(idx.before.name)};`);
      if (idx.after) out.push(createIndexSql(change.name, idx.after));
    }
    for (const trg of change.triggers) {
      if (trg.before) out.push(...dropTriggerSql(trg.before, change.name));
    }
  }

  for (const table of diff.addedTables) {
    for (const fk of Object.values(table.foreignKeys)) out.push(addForeignKeySql(table.name, fk));
  }
  for (const change of diff.changedTables) {
    for (const fk of change.foreignKeys) {
      if (fk.after && !(fk.before && sameForeignKey(fk.before, fk.after))) out.push(addForeignKeySql(change.name, fk.after));
    }
  }

  const created = new Set<string>();
  for (const table of diff.addedTables) {
    for (const trg of Object.values(table.triggers)) out.push(...createTriggerSql(trg, table.name, created));
  }
  for (const change of diff.changedTables) {
    for (const trg of change.triggers) {
      if (trg.after) out.push(...createTriggerSql(trg.after, change.name, created));
    }
  }

  if (diff.droppedTables.length > 0) {
    for (const table of diff.droppedTables) {
      out.push(
        `-- WARNING: drops table "${table.name}" and all its rows. Keep this only if the data is not needed.`,
      );
    }
    out.push(`DROP TABLE ${diff.droppedTables.map((t) => q(t.name)).join(', ')};`);
    for (const table of diff.droppedTables) {
      for (const trigger of Object.values(table.triggers)) {
        if (!trigger.function) out.push(`DROP FUNCTION IF EXISTS ${q(`${trigger.name}_fn`)}();`);
      }
    }
  }

  return out;
}
