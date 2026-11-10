import type {
  ColumnSnapshot,
  ForeignKeySnapshot,
  IndexSnapshot,
  SchemaSnapshot,
  TableCheckSnapshot,
  TableSnapshot,
  TriggerSnapshot,
} from './snapshot.js';

export interface ColumnChange {
  name: string;
  before?: ColumnSnapshot;
  after?: ColumnSnapshot;
}

export interface IndexChange {
  name: string;
  before?: IndexSnapshot;
  after?: IndexSnapshot;
}

export interface TriggerChange {
  name: string;
  before?: TriggerSnapshot;
  after?: TriggerSnapshot;
}

export interface ForeignKeyChange {
  key: string;
  before?: ForeignKeySnapshot;
  after?: ForeignKeySnapshot;
}

export interface TableCheckChange {
  name: string;
  before?: TableCheckSnapshot;
  after?: TableCheckSnapshot;
}

export interface TableChange {
  name: string;
  prevTable: TableSnapshot;
  nextTable: TableSnapshot;
  columns: ColumnChange[];
  indexes: IndexChange[];
  triggers: TriggerChange[];
  foreignKeys: ForeignKeyChange[];
  checks: TableCheckChange[];
}

export interface SchemaDiff {
  addedTables: TableSnapshot[];
  droppedTables: TableSnapshot[];
  changedTables: TableChange[];
}

export function diffSnapshots(prev: SchemaSnapshot, next: SchemaSnapshot): SchemaDiff {
  const prevTables: Record<string, TableSnapshot> = prev?.tables ?? {};
  const nextTables: Record<string, TableSnapshot> = next?.tables ?? {};

  const addedTables: TableSnapshot[] = [];
  const droppedTables: TableSnapshot[] = [];
  const changedTables: TableChange[] = [];

  for (const name of Object.keys(nextTables)) {
    if (!(name in prevTables)) {
      addedTables.push(nextTables[name]);
    }
  }

  for (const name of Object.keys(prevTables)) {
    if (!(name in nextTables)) {
      droppedTables.push(prevTables[name]);
    }
  }

  for (const name of Object.keys(nextTables)) {
    if (!(name in prevTables)) continue;

    const prevTable = prevTables[name];
    const nextTable = nextTables[name];

    const columns: ColumnChange[] = [];
    const indexes: IndexChange[] = [];
    const triggers: TriggerChange[] = [];
    const foreignKeys: ForeignKeyChange[] = [];

    for (const col of Object.values(nextTable.columns)) {
      if (!(col.name in prevTable.columns)) {
        columns.push({ name: col.name, after: col });
      } else {
        const prevCol = prevTable.columns[col.name];
        if (JSON.stringify(prevCol) !== JSON.stringify(col)) {
          columns.push({ name: col.name, before: prevCol, after: col });
        }
      }
    }

    for (const col of Object.values(prevTable.columns)) {
      if (!(col.name in nextTable.columns)) {
        columns.push({ name: col.name, before: col });
      }
    }

    for (const idx of Object.values(nextTable.indexes)) {
      if (!(idx.name in prevTable.indexes)) {
        indexes.push({ name: idx.name, after: idx });
      } else {
        const prevIdx = prevTable.indexes[idx.name];
        if (JSON.stringify(prevIdx) !== JSON.stringify(idx)) {
          indexes.push({ name: idx.name, before: prevIdx, after: idx });
        }
      }
    }

    for (const idx of Object.values(prevTable.indexes)) {
      if (!(idx.name in nextTable.indexes)) {
        indexes.push({ name: idx.name, before: idx });
      }
    }

    for (const trg of Object.values(nextTable.triggers)) {
      if (!(trg.name in prevTable.triggers)) {
        triggers.push({ name: trg.name, after: trg });
      } else {
        const prevTrg = prevTable.triggers[trg.name];
        if (JSON.stringify(prevTrg) !== JSON.stringify(trg)) {
          triggers.push({ name: trg.name, before: prevTrg, after: trg });
        }
      }
    }

    for (const trg of Object.values(prevTable.triggers)) {
      if (!(trg.name in nextTable.triggers)) {
        triggers.push({ name: trg.name, before: trg });
      }
    }

    const prevFks = prevTable.foreignKeys ?? {};
    const nextFks = nextTable.foreignKeys ?? {};
    for (const [key, fk] of Object.entries(nextFks)) {
      if (!(key in prevFks)) {
        foreignKeys.push({ key, after: fk });
      } else {
        const prevFk = prevFks[key];
        if (JSON.stringify(prevFk) !== JSON.stringify(fk)) {
          foreignKeys.push({ key, before: prevFk, after: fk });
        }
      }
    }

    for (const [key, fk] of Object.entries(prevFks)) {
      if (!(key in nextFks)) {
        foreignKeys.push({ key, before: fk });
      }
    }

    const checks: TableCheckChange[] = [];
    const prevChecks = prevTable.checks ?? {};
    const nextChecks = nextTable.checks ?? {};
    for (const check of Object.values(nextChecks)) {
      const prevCheck = prevChecks[check.name];
      if (!prevCheck) checks.push({ name: check.name, after: check });
      else if (prevCheck.sql !== check.sql) checks.push({ name: check.name, before: prevCheck, after: check });
    }
    for (const check of Object.values(prevChecks)) {
      if (check.name in nextChecks) continue;
      const renamed = checks.find((c) => !c.before && c.after!.sql === check.sql);
      if (renamed) renamed.before = check;
      else checks.push({ name: check.name, before: check });
    }

    if (columns.length > 0 || indexes.length > 0 || triggers.length > 0 || foreignKeys.length > 0 || checks.length > 0) {
      changedTables.push({ name, prevTable, nextTable, columns, indexes, triggers, foreignKeys, checks });
    }
  }

  return { addedTables, droppedTables, changedTables };
}

export type Rename =
  | { kind: 'table'; from: string; to: string }
  | { kind: 'column'; table: string; from: string; to: string };

export function findRenameCandidates(diff: SchemaDiff): Rename[] {
  const renames: Rename[] = [];
  for (const dropped of diff.droppedTables) {
    for (const added of diff.addedTables) {
      renames.push({ kind: 'table', from: dropped.name, to: added.name });
    }
  }
  for (const table of diff.changedTables) {
    const dropped = table.columns.filter((c) => c.before && !c.after);
    const added = table.columns.filter((c) => !c.before && c.after);
    for (const d of dropped) {
      for (const a of added) {
        renames.push({ kind: 'column', table: table.name, from: d.name, to: a.name });
      }
    }
  }
  return renames;
}

function mapValues<T>(record: Record<string, T>, update: (value: T) => T): Record<string, T> {
  return renameKey(record, '', '', update);
}

function renameKey<T>(record: Record<string, T>, from: string, to: string, update: (value: T) => T): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key === from ? to : key] = update(value);
  }
  return out;
}

function renameTable(snapshot: SchemaSnapshot, from: string, to: string): SchemaSnapshot {
  const mapForeignKey = (fk: ForeignKeySnapshot): ForeignKeySnapshot =>
    fk.refTable === from ? { ...fk, refTable: to } : fk;
  const tables = renameKey(snapshot.tables, from, to, (table) => ({
    ...table,
    name: table.name === from ? to : table.name,
    triggers: mapValues(table.triggers, (t) => (t.tableName === from ? { ...t, tableName: to } : t)),
    foreignKeys: mapValues(table.foreignKeys, mapForeignKey),
  }));
  return { ...snapshot, tables };
}

function renameColumn(snapshot: SchemaSnapshot, tableName: string, from: string, to: string): SchemaSnapshot {
  const swap = (names: string[]) => names.map((n) => (n === from ? to : n));
  const tables: Record<string, TableSnapshot> = {};
  for (const [name, table] of Object.entries(snapshot.tables)) {
    const foreignKeys: Record<string, ForeignKeySnapshot> = {};
    for (const [key, fk] of Object.entries(table.foreignKeys)) {
      let next = fk;
      let nextKey = key;
      if (name === tableName && fk.columns.includes(from)) {
        next = { ...next, columns: swap(next.columns) };
        nextKey = next.columns.join(',');
      }
      if (fk.refTable === tableName && fk.refColumns.includes(from)) {
        next = { ...next, refColumns: swap(next.refColumns) };
      }
      foreignKeys[nextKey] = next;
    }
    if (name !== tableName) {
      tables[name] = { ...table, foreignKeys };
      continue;
    }
    tables[name] = {
      ...table,
      columns: renameKey(table.columns, from, to, (c) => (c.name === from ? { ...c, name: to } : c)),
      indexes: mapValues(table.indexes, (i) => ({ ...i, columns: swap(i.columns) })),
      foreignKeys,
    };
  }
  return { ...snapshot, tables };
}

export function applyRenames(prev: SchemaSnapshot, renames: Rename[]): SchemaSnapshot {
  let snapshot = structuredClone(prev);
  for (const rename of renames) {
    snapshot =
      rename.kind === 'table'
        ? renameTable(snapshot, rename.from, rename.to)
        : renameColumn(snapshot, rename.table, rename.from, rename.to);
  }
  return snapshot;
}
