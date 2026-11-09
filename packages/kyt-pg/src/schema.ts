import * as v from 'valibot';
import type { ColumnType, Generated, GeneratedAlways } from 'kysely';
import type { VirtualTable } from './virtual-table.js';

export type PgType =
  | 'text'
  | 'uuid'
  | 'integer'
  | 'bigint'
  | 'boolean'
  | 'jsonb'
  | 'timestamptz'
  | 'date'
  | 'numeric'
  | `numeric(${number},${number})`
  | 'double precision';

export type IdType = 'bigint' | 'integer' | 'uuid';

export interface TableOptions {
  primaryKey?: boolean;
  id?: IdType;
  createdAt?: boolean;
  updatedAt?: boolean;
  primaryKeyColumn?: string;
  createdAtColumn?: string;
  updatedAtColumn?: string;
}

export interface SchemaIndex {
  readonly _tableName: string;
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly where?: string;
}

export interface SchemaForeignKey {
  readonly columns: readonly string[];
  readonly references: SchemaTable<any, any>;
  readonly refColumns?: readonly string[];
  readonly onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  readonly onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  readonly deferrable?: 'immediate' | 'deferred';
}

export interface SchemaTrigger {
  readonly name: string;
  readonly timing: 'BEFORE' | 'AFTER';
  readonly event: 'INSERT' | 'UPDATE' | 'DELETE';
  readonly tableName: string;
  readonly body: string;
}

export interface SqlDefault {
  readonly _tag: 'sqlDefault';
  readonly sql: string;
}

export function sqlDefault(sql: string): SqlDefault {
  return { _tag: 'sqlDefault', sql };
}

export interface WithDefault<S extends v.BaseSchema<any, any, any>, D> {
  readonly _tag: 'withDefault';
  readonly schema: S;
  readonly value: D;
}

export function withDefault<
  S extends v.BaseSchema<any, any, any>,
  D extends v.InferOutput<S> | SqlDefault,
>(schema: S, value: D): WithDefault<S, D> {
  return { _tag: 'withDefault', schema, value };
}

export type AnyColSchema =
  | v.BaseSchema<any, any, any>
  | WithDefault<v.BaseSchema<any, any, any>, any>;

type PkColName<O extends TableOptions> = O['primaryKeyColumn'] extends string
  ? O['primaryKeyColumn']
  : 'id';

type CreatedColName<O extends TableOptions> = O['createdAtColumn'] extends string
  ? O['createdAtColumn']
  : 'createdAt';

type UpdatedColName<O extends TableOptions> = O['updatedAtColumn'] extends string
  ? O['updatedAtColumn']
  : 'updatedAt';

type IdSelect<O extends TableOptions> = O['id'] extends 'integer'
  ? number
  : O['id'] extends 'uuid'
    ? string
    : bigint;

type IdKysely<O extends TableOptions> = O['id'] extends 'uuid'
  ? Generated<string>
  : GeneratedAlways<IdSelect<O>>;

type AutoColumnsSelect<O extends TableOptions> =
  (O['primaryKey'] extends false ? object : { [K in PkColName<O>]: IdSelect<O> }) &
  (O['createdAt'] extends false ? object : { [K in CreatedColName<O>]: Date }) &
  (O['updatedAt'] extends false ? object : { [K in UpdatedColName<O>]: Date });

type AutoColumnsInsert<O extends TableOptions> =
  (O['primaryKey'] extends false ? object : { [K in PkColName<O>]?: IdSelect<O> }) &
  (O['createdAt'] extends false ? object : { [K in CreatedColName<O>]?: Date }) &
  (O['updatedAt'] extends false ? object : { [K in UpdatedColName<O>]?: Date });

type AutoColumnsKysely<O extends TableOptions> =
  (O['primaryKey'] extends false ? object : { [K in PkColName<O>]: IdKysely<O> }) &
  (O['createdAt'] extends false ? object : { [K in CreatedColName<O>]: Generated<Date> }) &
  (O['updatedAt'] extends false ? object : { [K in UpdatedColName<O>]: Generated<Date> });

type IsJsonOutput<T> =
  [T] extends [string | number | boolean | bigint | Date | null | undefined] ? false :
  [T] extends [object] ? true :
  false;

type ColOutput<S extends AnyColSchema> =
  S extends WithDefault<infer Inner extends v.BaseSchema<any, any, any>, any>
    ? v.InferOutput<Inner>
    : S extends v.BaseSchema<any, any, any>
      ? v.InferOutput<S>
      : never;

type IsInsertOptional<S extends AnyColSchema> =
  S extends WithDefault<any, any>
    ? true
    : S extends { type: 'nullable' }
      ? true
      : false;

type InferKyselyColumn<S extends AnyColSchema> =
  S extends WithDefault<infer Inner extends v.BaseSchema<any, any, any>, any>
    ? IsJsonOutput<v.InferOutput<Inner>> extends true
      ? ColumnType<v.InferOutput<Inner>, v.InferOutput<Inner> | undefined, v.InferOutput<Inner>>
      : Generated<v.InferOutput<Inner>>
    : S extends { type: 'nullable'; wrapped: infer Inner extends v.BaseSchema<any, any, any> }
      ? v.InferOutput<Inner> | null
      : S extends v.BaseSchema<any, any, any>
        ? IsJsonOutput<v.InferOutput<S>> extends true
          ? ColumnType<v.InferOutput<S>, v.InferOutput<S>, v.InferOutput<S>>
          : v.InferOutput<S>
        : never;

export type InferDB<Tables extends Record<string, SchemaTable<any, any> | VirtualTable<any, any>>> = {
  [K in keyof Tables]: {
    [C in keyof Tables[K]['_columns']]: InferKyselyColumn<Tables[K]['_columns'][C]>;
  } & AutoColumnsKysely<Tables[K]['_options']>;
};

export type InferSelect<
  Cols extends Record<string, AnyColSchema>,
  O extends TableOptions = object,
> = {
  [K in keyof Cols]: ColOutput<Cols[K]>;
} & AutoColumnsSelect<O>;

export type InferInsert<
  Cols extends Record<string, AnyColSchema>,
  O extends TableOptions = object,
> = {
  [K in keyof Cols as IsInsertOptional<Cols[K]> extends true ? never : K]: ColOutput<Cols[K]>;
} & {
  [K in keyof Cols as IsInsertOptional<Cols[K]> extends true ? K : never]?: ColOutput<Cols[K]>;
} & AutoColumnsInsert<O>;

export interface SchemaTable<
  Cols extends Record<string, AnyColSchema> = Record<string, AnyColSchema>,
  O extends TableOptions = object,
> {
  readonly _name: string;
  readonly _columns: Cols;
  readonly _options: O;
  readonly _indexes: SchemaIndex[];
  readonly _triggers: SchemaTrigger[];
  readonly _foreignKeys: SchemaForeignKey[];
  readonly _schemaTable: true;
  $inferSelect: InferSelect<Cols, O>;
  $inferInsert: InferInsert<Cols, O>;
}

export interface ColumnTypeInfo {
  type: PgType;
  notNull: boolean;
  default?: string;
  values?: (string | number)[];
}

type NumericMetadata = {
  readonly kytPgNumeric: { readonly precision: number; readonly scale: number };
};

export function numeric<TInput extends string>(
  precision: number,
  scale = 0,
): v.MetadataAction<TInput, NumericMetadata> {
  if (!Number.isInteger(precision) || precision < 1 || precision > 1000) {
    throw new Error(`kyt-pg: numeric precision must be a whole number from 1 to 1000, got ${precision}`);
  }
  if (!Number.isInteger(scale) || scale < 0 || scale > precision) {
    throw new Error(`kyt-pg: numeric scale must be a whole number from 0 to ${precision}, got ${scale}`);
  }
  return v.metadata<TInput, NumericMetadata>({ kytPgNumeric: { precision, scale } });
}

function numericMetadata(inner: any): NumericMetadata['kytPgNumeric'] | undefined {
  if (!Array.isArray(inner.pipe)) return undefined;
  const item = inner.pipe.find((p: any) => p.kind === 'metadata' && p.type === 'metadata' && p.metadata?.kytPgNumeric);
  return item?.metadata.kytPgNumeric;
}

function quote(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

class ColumnError extends Error {
  constructor(readonly problem: string) {
    super(`kyt-pg: ${problem}`);
  }
}

function jsonDefault(def: object): string {
  try {
    return `${quote(JSON.stringify(def))}::jsonb`;
  } catch {
    throw new ColumnError('default holds a bigint, and JSON cannot store a bigint');
  }
}

function renderDefault(def: unknown): string {
  if (def === null) return 'NULL';
  if (typeof def === 'string') return quote(def);
  if (typeof def === 'number') {
    if (!Number.isFinite(def)) throw new ColumnError(`default ${def} is not a finite number`);
    return String(def);
  }
  if (typeof def === 'bigint') return String(def);
  if (typeof def === 'boolean') return def ? 'true' : 'false';
  if (def instanceof Date) return `${quote(def.toISOString())}::timestamptz`;
  if ((def as SqlDefault)?._tag === 'sqlDefault') return (def as SqlDefault).sql;
  if (typeof def === 'object') return jsonDefault(def);
  throw new ColumnError(`unsupported default value of type "${typeof def}"`);
}

function hasPipeAction(inner: any, type: string): boolean {
  return (
    Array.isArray(inner.pipe) &&
    inner.pipe.some((item: any) => item.type === type && item.kind === 'validation')
  );
}

export function pgTypeFromSchema(schema: AnyColSchema): ColumnTypeInfo {
  if ((schema as any)._tag === 'withDefault') {
    const wd = schema as WithDefault<v.BaseSchema<any, any, any>, any>;
    const info = pgTypeFromSchema(wd.schema);
    return { ...info, default: renderDefault(wd.value) };
  }

  let nullable = false;
  let inner: any = schema;
  if (inner?.type === 'nullable') {
    nullable = true;
    inner = inner.wrapped;
  }

  const notNull = !nullable;
  const precision = inner ? numericMetadata(inner) : undefined;
  if (precision && !(inner.type === 'string' && hasPipeAction(inner, 'decimal'))) {
    throw new ColumnError('numeric() needs v.pipe(v.string(), v.decimal(), numeric(...))');
  }
  switch (inner?.type) {
    case 'string':
      if (hasPipeAction(inner, 'uuid')) return { type: 'uuid', notNull };
      if (precision) return { type: `numeric(${precision.precision},${precision.scale})`, notNull };
      if (hasPipeAction(inner, 'decimal')) return { type: 'numeric', notNull };
      if (hasPipeAction(inner, 'iso_date')) return { type: 'date', notNull };
      return { type: 'text', notNull };
    case 'number':
      return { type: hasPipeAction(inner, 'integer') ? 'integer' : 'double precision', notNull };
    case 'bigint':
      return { type: 'bigint', notNull };
    case 'boolean':
      return { type: 'boolean', notNull };
    case 'object':
    case 'array':
      return { type: 'jsonb', notNull };
    case 'date':
      return { type: 'timestamptz', notNull };
    case 'picklist':
      return { type: 'text', notNull, values: [...inner.options] };
    default:
      throw new ColumnError(`unsupported Valibot type "${inner?.type ?? 'unknown'}"`);
  }
}

const tableRegistry = new Map<string, SchemaTable<any, any>>();

export function getTableRegistry(): ReadonlyMap<string, SchemaTable<any, any>> {
  return tableRegistry;
}

export function defineTable<
  Cols extends Record<string, AnyColSchema>,
  O extends TableOptions = object,
>(
  name: string,
  columns: Cols,
  options?: O & { foreignKeys?: Array<Omit<SchemaForeignKey, 'columns'> & { columns: readonly (keyof Cols & string)[] }> },
): SchemaTable<Cols, O> {
  for (const [column, schema] of Object.entries(columns)) {
    try {
      pgTypeFromSchema(schema);
    } catch (error) {
      if (!(error instanceof ColumnError)) throw error;
      throw new Error(`kyt-pg: column "${name}"."${column}": ${error.problem}`);
    }
  }
  const table = {
    _name: name,
    _columns: columns,
    _options: (options ?? {}) as O,
    _indexes: [],
    _triggers: [],
    _foreignKeys: [...(options?.foreignKeys ?? [])],
    _schemaTable: true,
  } as unknown as SchemaTable<Cols, O>;
  tableRegistry.set(name, table);
  return table;
}

export function defineIndex<Cols extends Record<string, AnyColSchema>>(
  table: SchemaTable<Cols, any>,
  columns: readonly (keyof Cols & string)[],
  options?: { unique?: boolean; name?: string; where?: string },
): SchemaIndex {
  const unique = options?.unique ?? false;
  const suffix = unique ? 'uq' : 'idx';
  const name = options?.name ?? `${table._name}_${columns.join('_')}_${suffix}`;

  const index: SchemaIndex = {
    _tableName: table._name,
    name,
    columns: [...columns],
    unique,
    where: options?.where,
  };

  (table._indexes as SchemaIndex[]).push(index);
  return index;
}

export function defineTrigger(
  name: string,
  options: {
    timing: 'BEFORE' | 'AFTER';
    event: 'INSERT' | 'UPDATE' | 'DELETE';
    on: SchemaTable<any, any>;
    body: string;
  },
): SchemaTrigger {
  const trigger: SchemaTrigger = {
    name,
    timing: options.timing,
    event: options.event,
    tableName: options.on._name,
    body: options.body,
  };

  (options.on._triggers as SchemaTrigger[]).push(trigger);
  return trigger;
}
