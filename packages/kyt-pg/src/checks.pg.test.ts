import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as v from 'valibot';
import { freshDb } from '../test/pg.js';
import { defineTable, numeric } from './schema.js';
import { serializeSchema, EMPTY_SNAPSHOT } from './snapshot.js';
import { diffSnapshots } from './diff.js';
import { diffToSQL, diffToValidateSQL } from './sql.js';
import { migrate } from './migrate.js';

let db: Awaited<ReturnType<typeof freshDb>>;
let dir: string;

beforeAll(async () => {
  db = await freshDb();
  dir = mkdtempSync(join(tmpdir(), 'kyt-pg-checks-'));
  const Item = defineTable('Item', {
    kind: v.picklist(['tool', 'part']),
    note: v.nullable(v.picklist(['new', 'used'])),
    price: v.pipe(v.string(), v.decimal(), numeric(18, 2)),
  });
  const Box = defineTable('Box', { label: v.string() });
  writeFileSync(join(dir, '0001.sql'), diffToSQL(diffSnapshots(EMPTY_SNAPSHOT, serializeSchema({ Item, Box }))).join('\n'));
  await migrate(db.sql, { dir, log: () => {} });
});

afterAll(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

it('refuses a value outside the picklist', async () => {
  await expect(db.sql`insert into "Item" (kind, price) values ('food', '1')`).rejects.toThrow('Item_kind_check');
});

it('takes a picklist value and a null in a nullable picklist', async () => {
  await db.sql`insert into "Item" (kind, note, price) values ('tool', null, '1')`;
});

it('rounds to the numeric scale', async () => {
  const [row] = await db.sql`insert into "Item" (kind, price) values ('part', '12.345') returning price`;
  expect(row.price).toBe('12.35');
});

it('keeps one shared updatedAt function for all tables', async () => {
  const fns = await db.sql`select proname from pg_proc where proname like '%updatedAt%' order by proname`;
  expect(fns.map((f) => f.proname)).toEqual(['kyt_set_updatedAt']);
  const [before] = await db.sql`insert into "Box" (label) values ('a') returning "updatedAt"`;
  const [after] = await db.sql`update "Box" set label = 'b' returning "updatedAt"`;
  expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
});

it('adds a narrowed check as NOT VALID, then the validate file finds the old row', async () => {
  const before = defineTable('Tag', { kind: v.picklist(['a', 'b']) });
  const prev = serializeSchema({ Tag: before });
  const tagDir = mkdtempSync(join(tmpdir(), 'kyt-pg-validate-'));
  const tagDb = await freshDb();
  try {
    writeFileSync(join(tagDir, '0001.sql'), diffToSQL(diffSnapshots(EMPTY_SNAPSHOT, prev)).join('\n'));
    await migrate(tagDb.sql, { dir: tagDir, log: () => {} });
    await tagDb.sql`insert into "Tag" (kind) values ('b')`;

    const next = structuredClone(prev);
    next.tables.Tag.columns.kind.check!.values = ['a'];
    const diff = diffSnapshots(prev, next);
    writeFileSync(join(tagDir, '0002.sql'), diffToSQL(diff).join('\n'));
    writeFileSync(join(tagDir, '0003.sql'), diffToValidateSQL(diff).join('\n'));

    await expect(migrate(tagDb.sql, { dir: tagDir, log: () => {} })).rejects.toThrow('Tag_kind_check');
    const [check] = await tagDb.sql`select convalidated from pg_constraint where conname = 'Tag_kind_check'`;
    expect(check.convalidated).toBe(false);
    await expect(tagDb.sql`insert into "Tag" (kind) values ('b')`).rejects.toThrow('Tag_kind_check');

    await tagDb.sql`update "Tag" set kind = 'a'`;
    expect((await migrate(tagDb.sql, { dir: tagDir, log: () => {} })).applied).toEqual(['0003.sql']);
    const [valid] = await tagDb.sql`select convalidated from pg_constraint where conname = 'Tag_kind_check'`;
    expect(valid.convalidated).toBe(true);
  } finally {
    await tagDb.close();
    rmSync(tagDir, { recursive: true, force: true });
  }
});
