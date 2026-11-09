import { describe, it, expect, expectTypeOf } from 'vitest';
import * as v from 'valibot';
import type { Insertable, Selectable } from 'kysely';
import {
  defineTable,
  defineIndex,
  defineTrigger,
  numeric,
  pgTypeFromSchema,
  sqlDefault,
  withDefault,
  type InferDB,
} from './schema.js';

type Simplify<T> = { [K in keyof T]: T[K] } & {};

describe('pgTypeFromSchema', () => {
  it('maps each Valibot type to a Postgres type', () => {
    expect(pgTypeFromSchema(v.string()).type).toBe('text');
    expect(pgTypeFromSchema(v.pipe(v.string(), v.uuid())).type).toBe('uuid');
    expect(pgTypeFromSchema(v.pipe(v.string(), v.decimal())).type).toBe('numeric');
    expect(pgTypeFromSchema(v.pipe(v.string(), v.isoDate())).type).toBe('date');
    expect(pgTypeFromSchema(v.pipe(v.number(), v.integer())).type).toBe('integer');
    expect(pgTypeFromSchema(v.number()).type).toBe('double precision');
    expect(pgTypeFromSchema(v.bigint()).type).toBe('bigint');
    expect(pgTypeFromSchema(v.boolean()).type).toBe('boolean');
    expect(pgTypeFromSchema(v.object({ a: v.string() })).type).toBe('jsonb');
    expect(pgTypeFromSchema(v.array(v.string())).type).toBe('jsonb');
    expect(pgTypeFromSchema(v.date()).type).toBe('timestamptz');
    expect(pgTypeFromSchema(v.picklist(['a', 'b'])).type).toBe('text');
  });

  it('marks nullable columns', () => {
    expect(pgTypeFromSchema(v.nullable(v.string())).notNull).toBe(false);
    expect(pgTypeFromSchema(v.string()).notNull).toBe(true);
  });

  it('renders defaults', () => {
    expect(pgTypeFromSchema(withDefault(v.string(), "it's")).default).toBe("'it''s'");
    expect(pgTypeFromSchema(withDefault(v.boolean(), false)).default).toBe('false');
    expect(pgTypeFromSchema(withDefault(v.pipe(v.number(), v.integer()), 0)).default).toBe('0');
    expect(pgTypeFromSchema(withDefault(v.bigint(), 10n)).default).toBe('10');
    expect(pgTypeFromSchema(withDefault(v.object({ t: v.string() }), { t: "o'k" })).default).toBe(`'{"t":"o''k"}'::jsonb`);
    expect(pgTypeFromSchema(withDefault(v.date(), sqlDefault('now()'))).default).toBe('now()');
    expect(pgTypeFromSchema(withDefault(v.nullable(v.string()), null)).default).toBe('NULL');
    expect(pgTypeFromSchema(withDefault(v.date(), new Date('2026-01-02T03:04:05.000Z'))).default).toBe(
      "'2026-01-02T03:04:05.000Z'::timestamptz",
    );
  });

  it('maps numeric() to a set precision and scale', () => {
    const money = v.pipe(v.string(), v.decimal(), numeric(18, 2));
    expect(pgTypeFromSchema(money).type).toBe('numeric(18,2)');
    expect(pgTypeFromSchema(v.nullable(money))).toEqual({ type: 'numeric(18,2)', notNull: false });
    expect(pgTypeFromSchema(withDefault(money, '0')).type).toBe('numeric(18,2)');
    expect(pgTypeFromSchema(v.pipe(v.string(), v.decimal(), numeric(10))).type).toBe('numeric(10,0)');
    expect(v.parse(money, '12.50')).toBe('12.50');
  });

  it('refuses a bad numeric()', () => {
    expect(() => numeric(0)).toThrow('kyt-pg: numeric precision must be a whole number from 1 to 1000, got 0');
    expect(() => numeric(5, 6)).toThrow('kyt-pg: numeric scale must be a whole number from 0 to 5, got 6');
    expect(() => pgTypeFromSchema(v.pipe(v.string(), numeric(18, 2)))).toThrow(
      'kyt-pg: numeric() needs v.pipe(v.string(), v.decimal(), numeric(...))',
    );
  });

  it('keeps picklist values', () => {
    expect(pgTypeFromSchema(v.picklist(['a', 'b'])).values).toEqual(['a', 'b']);
  });

  it('throws for an unsupported type', () => {
    expect(() => pgTypeFromSchema(v.union([v.string(), v.number()]))).toThrow(
      'kyt-pg: unsupported Valibot type "union"',
    );
  });
});

describe('defineTable', () => {
  it('names the column when a type is not supported', () => {
    expect(() => defineTable('Bad', { mixed: v.union([v.string(), v.number()]) }))
      .toThrow('kyt-pg: column "Bad"."mixed": unsupported Valibot type "union"');
  });

  it('names the column when a number default is not finite', () => {
    expect(() => defineTable('Bad', { score: withDefault(v.number(), NaN) }))
      .toThrow('kyt-pg: column "Bad"."score": default NaN is not a finite number');
    expect(() => defineTable('Bad', { score: withDefault(v.number(), Infinity) }))
      .toThrow('kyt-pg: column "Bad"."score": default Infinity is not a finite number');
  });

  it('names the column when a jsonb default holds a bigint', () => {
    expect(() => defineTable('Bad', { meta: withDefault(v.object({ n: v.bigint() }), { n: 1n }) }))
      .toThrow('kyt-pg: column "Bad"."meta": default holds a bigint, and JSON cannot store a bigint');
  });

  it('names the column when a default is undefined', () => {
    expect(() => defineTable('Bad', { name: withDefault(v.string(), undefined as unknown as string) }))
      .toThrow('kyt-pg: column "Bad"."name": unsupported default value of type "undefined"');
  });
});

describe('InferDB', () => {
  it('infers Postgres row types', () => {
    const User = defineTable('User', { email: v.string(), seenAt: v.nullable(v.date()) });
    const Tag = defineTable('Tag', { label: v.string() }, { id: 'uuid' });
    const Count = defineTable('Count', { n: v.string() }, { id: 'integer' });
    type DB = InferDB<{ User: typeof User; Tag: typeof Tag; Count: typeof Count }>;
    expectTypeOf<Simplify<Selectable<DB['User']>>>().toEqualTypeOf<{ id: bigint; email: string; seenAt: Date | null; createdAt: Date; updatedAt: Date }>();
    expectTypeOf<Selectable<DB['Tag']>['id']>().toEqualTypeOf<string>();
    expectTypeOf<Selectable<DB['Count']>['id']>().toEqualTypeOf<number>();
    expectTypeOf<Simplify<Insertable<DB['User']>>>().toEqualTypeOf<{ email: string; seenAt?: Date | null; createdAt?: Date; updatedAt?: Date }>();
    expectTypeOf<Insertable<DB['Tag']>['id']>().toEqualTypeOf<string | undefined>();
  });

  it('infers table phantom types', () => {
    const User = defineTable('User', { email: v.string(), score: withDefault(v.bigint(), 1n) });
    expectTypeOf<Simplify<typeof User.$inferSelect>>().toEqualTypeOf<{ email: string; score: bigint; id: bigint; createdAt: Date; updatedAt: Date }>();
    expectTypeOf<Simplify<typeof User.$inferInsert>>().toEqualTypeOf<{ email: string; score?: bigint; id?: bigint; createdAt?: Date; updatedAt?: Date }>();
  });
});

describe('defineIndex', () => {
  it('takes readonly column lists', () => {
    const Tag = defineTable('Tag', { a: v.string(), b: v.string() });
    const columns = ['a', 'b'] as const;
    expect(defineIndex(Tag, columns).columns).toEqual(['a', 'b']);
    const key = { columns: ['a'] as const, references: Tag, refColumns: ['a'] as const };
    expect(defineTable('Ref', { a: v.string() }, { foreignKeys: [key] })._foreignKeys[0].columns).toEqual(['a']);
  });

  it('adds an index with a generated name', () => {
    const User = defineTable('IdxUser', { email: v.string() });
    const idx = defineIndex(User, ['email'], { unique: true });
    expect(idx.name).toBe('IdxUser_email_uq');
    expect(idx._tableName).toBe('IdxUser');
    expect(User._indexes[0]).toBe(idx);
  });

  it('names a plain index with the idx suffix and accepts options', () => {
    const User = defineTable('IdxName', { a: v.string(), b: v.string() });
    expect(defineIndex(User, ['a', 'b']).name).toBe('IdxName_a_b_idx');
    expect(defineIndex(User, ['a'], { name: 'custom' }).name).toBe('custom');
    expect(defineIndex(User, ['a'], { where: '"b" = 1' }).where).toBe('"b" = 1');
  });

  it('checks column names', () => {
    const User = defineTable('IdxType', { email: v.string() });
    // @ts-expect-error 'nonexistent' is not a column
    defineIndex(User, ['nonexistent']);
  });
});

describe('defineTrigger', () => {
  it('adds a trigger to the table', () => {
    const User = defineTable('TrgUser', { email: v.string() });
    const trg = defineTrigger('TrgUser_audit', {
      timing: 'AFTER',
      event: 'INSERT',
      on: User,
      body: 'SELECT 1;',
    });
    expect(trg.tableName).toBe('TrgUser');
    expect(trg.timing).toBe('AFTER');
    expect(User._triggers[0]).toBe(trg);
  });
});
