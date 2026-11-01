import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as v from 'valibot';
import { freshDb } from '../test/pg.js';
import { expectedForeignKeys, expectedFrom, expectedIndexes, expectedTriggers, onDeleteFromCode } from '../test/columns.js';
import { defineTable, defineIndex } from './schema.js';
import type { InferDB } from './schema.js';
import { defineVirtualTable } from './virtual-table.js';
import { createQueryBuilder } from './query-builder.js';
import { queryAll, queryRun } from './executor.js';
import { serializeSchema, EMPTY_SNAPSHOT } from './snapshot.js';
import { diffSnapshots, applyRenames } from './diff.js';
import type { Rename } from './diff.js';
import { diffToSQL } from './sql.js';
import { migrate } from './migrate.js';

let db: Awaited<ReturnType<typeof freshDb>>;
let dir: string;

beforeAll(async () => {
  db = await freshDb();
  dir = mkdtempSync(join(tmpdir(), 'kyt-pg-e2e-'));
});

afterAll(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function expectDatabaseMatches(snapshot: ReturnType<typeof serializeSchema>) {
  const cols = await db.sql`
    select table_name, column_name, data_type, is_nullable
    from information_schema.columns
    where table_schema = 'public' and table_name <> 'KytMigration'
    order by table_name, column_name`;
  const byName = (a: { table_name: string; column_name: string }, b: typeof a) =>
    a.table_name.localeCompare(b.table_name) || a.column_name.localeCompare(b.column_name);
  expect([...cols]).toEqual(expectedFrom(snapshot).sort(byName));

  const indexes = await db.sql`
    select t.relname as table_name, i.relname as index_name, x.indisunique as unique
    from pg_index x
    join pg_class i on i.oid = x.indexrelid
    join pg_class t on t.oid = x.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and not x.indisprimary and t.relname <> 'KytMigration'
    order by i.relname`;
  expect([...indexes]).toEqual(expectedIndexes(snapshot));

  const foreignKeys = await db.sql`
    select t.relname as table_name, c.conname as constraint_name, r.relname as ref_table, c.confdeltype as on_delete
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_class r on r.oid = c.confrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and c.contype = 'f'
    order by c.conname`;
  expect(foreignKeys.map((fk) => ({ ...fk, on_delete: onDeleteFromCode(fk.on_delete) }))).toEqual(
    expectedForeignKeys(snapshot),
  );

  const triggers = await db.sql`
    select t.relname as table_name, g.tgname as trigger_name
    from pg_trigger g
    join pg_class t on t.oid = g.tgrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and not g.tgisinternal
    order by g.tgname`;
  expect([...triggers]).toEqual(expectedTriggers(snapshot));
}

it('goes from schema to typed queries through migrations', async () => {
  const UserV1 = defineTable('User', { email: v.string(), name: v.string() });
  const PostV1 = defineTable(
    'Post',
    { authorId: v.bigint(), title: v.string(), published: v.boolean() },
    { foreignKeys: [{ columns: ['authorId'], references: UserV1, onDelete: 'CASCADE' }] },
  );
  const v1 = serializeSchema({ UserV1, PostV1 });

  writeFileSync(join(dir, '0001.sql'), diffToSQL(diffSnapshots(EMPTY_SNAPSHOT, v1)).join('\n') + '\n');
  expect((await migrate(db.sql, { dir, log: () => {} })).applied).toEqual(['0001.sql']);
  await expectDatabaseMatches(v1);

  const UserV2 = defineTable('User', { email: v.string(), fullName: v.string() });
  const PostV2 = defineTable(
    'Post',
    { authorId: v.bigint(), title: v.string(), published: v.boolean(), summary: v.nullable(v.string()) },
    { foreignKeys: [{ columns: ['authorId'], references: UserV2, onDelete: 'CASCADE' }] },
  );
  defineIndex(PostV2, ['authorId']);
  const PublishedPost = defineVirtualTable('PublishedPost', PostV2, ['authorId', 'title', 'summary'], {
    where: { published: true },
  });
  const PostWithAuthor = defineVirtualTable('PostWithAuthor', PostV2, ['title'], {
    joins: [{ table: UserV2, on: ['authorId', 'id'], columns: ['fullName'] }],
  });
  const v2 = serializeSchema({ UserV2, PostV2 });

  const renames: Rename[] = [{ kind: 'column', table: 'User', from: 'name', to: 'fullName' }];
  const diff = diffSnapshots(applyRenames(v1, renames), v2);
  const lines = diffToSQL(diff, renames);
  expect(lines.some((l) => l.startsWith('-- WARNING'))).toBe(false);
  writeFileSync(join(dir, '0002.sql'), lines.join('\n') + '\n');

  await queryRun(db.sql, createQueryBuilder<any>().insertInto('User').values({ email: 'a@x.io', name: 'Ada' }).compile());
  expect((await migrate(db.sql, { dir, log: () => {} })).applied).toEqual(['0002.sql']);
  await expectDatabaseMatches(v2);

  type DB = InferDB<{ User: typeof UserV2; Post: typeof PostV2 }>;
  const qb = createQueryBuilder<DB & { PublishedPost: DB['Post']; PostWithAuthor: { title: string; fullName: string } }>([
    PublishedPost,
    PostWithAuthor,
  ]);

  const [user] = await queryAll(
    db.sql,
    qb.selectFrom('User').select(['id', 'fullName']).where('email', '=', 'a@x.io').compile(),
  );
  expect(user.fullName).toBe('Ada');
  expect(typeof user.id).toBe('bigint');

  const insert = await queryRun(
    db.sql,
    qb
      .insertInto('Post')
      .values([
        { authorId: user.id, title: 'Shown', published: true, summary: 'hi' },
        { authorId: user.id, title: 'Hidden', published: false },
      ])
      .compile(),
  );
  expect(insert.count).toBe(2);

  const rows = await queryAll(
    db.sql,
    qb.selectFrom('PublishedPost').select(['id', 'title', 'summary', 'createdAt']).compile(),
  );
  expect(rows).toHaveLength(1);
  const row = rows[0] as any;
  expect(row.title).toBe('Shown');
  expect(row.summary).toBe('hi');
  expect(typeof row.id).toBe('bigint');
  expect(row.createdAt).toBeInstanceOf(Date);

  const qualified = await queryAll(
    db.sql,
    qb.selectFrom('PublishedPost').select('PublishedPost.title').compile(),
  );
  expect(qualified).toEqual([{ title: 'Shown' }]);

  const aliased = await queryAll(db.sql, qb.selectFrom('PublishedPost as p').selectAll('p').compile());
  expect(aliased).toHaveLength(1);
  expect(Object.keys(aliased[0] as object).sort()).toEqual(['authorId', 'createdAt', 'id', 'summary', 'title', 'updatedAt']);

  const joined = await queryAll(
    db.sql,
    qb.selectFrom('PostWithAuthor').select(['title', 'fullName']).orderBy('title').compile(),
  );
  expect(joined).toEqual([
    { title: 'Hidden', fullName: 'Ada' },
    { title: 'Shown', fullName: 'Ada' },
  ]);
});

it('stores decimal as numeric and isoDate as date', async () => {
  const Price = defineTable('Price', {
    amount: v.pipe(v.string(), v.decimal()),
    day: v.pipe(v.string(), v.isoDate()),
  });
  const snapshot = serializeSchema({ Price });
  const priceDir = mkdtempSync(join(tmpdir(), 'kyt-pg-price-'));
  writeFileSync(join(priceDir, 'price.sql'), diffToSQL(diffSnapshots(EMPTY_SNAPSHOT, snapshot)).join('\n') + '\n');
  await migrate(db.sql, { dir: priceDir, log: () => {} });
  rmSync(priceDir, { recursive: true, force: true });

  const cols = await db.sql`
    select column_name, data_type from information_schema.columns
    where table_name = 'Price' and column_name in ('amount', 'day') order by column_name`;
  expect([...cols]).toEqual([
    { column_name: 'amount', data_type: 'numeric' },
    { column_name: 'day', data_type: 'date' },
  ]);

  type DB = InferDB<{ Price: typeof Price }>;
  const qb = createQueryBuilder<DB>();
  await queryRun(db.sql, qb.insertInto('Price').values({ amount: '0.10', day: '2026-11-01' }).compile());
  await queryRun(db.sql, qb.insertInto('Price').values({ amount: '0.20', day: '2026-11-01' }).compile());
  const [sum] = await queryAll(db.sql, qb.selectFrom('Price').select((eb) => eb.fn.sum<string>('amount').as('total')).compile());
  expect(sum.total).toBe('0.30');
});
