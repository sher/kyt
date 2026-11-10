import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import { defineCheck, defineForeignKey, defineTable, defineIndex, defineTrigger, withDefault } from './schema.js';
import { serializeSchema, EMPTY_SNAPSHOT } from './snapshot.js';

describe('serializeSchema', () => {
  it('adds a bigint identity id, and time columns', () => {
    const User = defineTable('User', { email: v.string() });
    const t = serializeSchema({ User }).tables.User;
    expect(Object.keys(t.columns)).toEqual(['id', 'email', 'createdAt', 'updatedAt']);
    expect(t.columns.id).toEqual({ name: 'id', type: 'bigint', notNull: true, primaryKey: true, identity: true });
    expect(t.columns.createdAt).toEqual({ name: 'createdAt', type: 'timestamptz', notNull: true, default: 'now()' });
    expect(t.columns.updatedAt).toEqual({ name: 'updatedAt', type: 'timestamptz', notNull: true, default: 'now()' });
  });

  it('uses a uuid id when the table asks for it', () => {
    const Tag = defineTable('Tag', { label: v.string() }, { id: 'uuid' });
    expect(serializeSchema({ Tag }).tables.Tag.columns.id).toEqual({ name: 'id', type: 'uuid', notNull: true, primaryKey: true, default: 'gen_random_uuid()' });
  });

  it('uses an integer identity id when the table asks for it', () => {
    const Tag = defineTable('Tag', { label: v.string() }, { id: 'integer' });
    expect(serializeSchema({ Tag }).tables.Tag.columns.id).toEqual({ name: 'id', type: 'integer', notNull: true, primaryKey: true, identity: true });
  });

  it('adds a BEFORE UPDATE trigger for updatedAt', () => {
    const User = defineTable('User', { email: v.string() });
    expect(serializeSchema({ User }).tables.User.triggers.User_updatedAt_trg).toEqual({
      name: 'User_updatedAt_trg', timing: 'BEFORE', event: 'UPDATE', tableName: 'User', body: 'NEW."updatedAt" = now();',
      function: 'kyt_set_updatedAt',
    });
  });

  it('keeps tables in the order they were defined, not the export order', () => {
    const Zone = defineTable('Zone', { label: v.string() });
    const Area = defineTable('Area', { zoneId: v.bigint() });
    expect(Object.keys(serializeSchema({ Area, Zone }).tables)).toEqual(['Zone', 'Area']);
  });

  it('stores picklist values as a named check', () => {
    const User = defineTable('User', { role: v.picklist(['admin', 'member']) });
    expect(serializeSchema({ User }).tables.User.columns.role.check).toEqual({
      name: 'User_role_check',
      values: ['admin', 'member'],
    });
  });

  it('marks the snapshot as postgres', () => {
    expect(serializeSchema({}).dialect).toBe('postgres');
    expect(EMPTY_SNAPSHOT).toEqual({ version: 1, dialect: 'postgres', tables: {} });
  });

  it('keeps default absent when a column has none', () => {
    const User = defineTable('User', { email: v.string() });
    expect('default' in serializeSchema({ User }).tables.User.columns.email).toBe(false);
  });

  it('respects options that turn auto columns off', () => {
    const T = defineTable('T', { slug: v.string() }, { primaryKey: false, createdAt: false, updatedAt: false });
    const t = serializeSchema({ T }).tables.T;
    expect(Object.keys(t.columns)).toEqual(['slug']);
    expect(Object.keys(t.triggers)).toHaveLength(0);
  });

  it('respects custom column names', () => {
    const T = defineTable('T', { slug: v.string() }, { primaryKeyColumn: 'pk', createdAtColumn: 'made', updatedAtColumn: 'changed' });
    const t = serializeSchema({ T }).tables.T;
    expect(Object.keys(t.columns)).toEqual(['pk', 'slug', 'made', 'changed']);
    expect(t.triggers.T_changed_trg.body).toBe('NEW."changed" = now();');
  });

  it('includes indexes', () => {
    const User = defineTable('User', { email: v.string() });
    defineIndex(User, ['email'], { unique: true });
    expect(serializeSchema({ User }).tables.User.indexes.User_email_uq).toEqual({
      name: 'User_email_uq', columns: ['email'], unique: true,
    });
  });

  it('keeps the where clause of an index', () => {
    const User = defineTable('User', { email: v.string() });
    defineIndex(User, ['email'], { where: '"email" IS NOT NULL' });
    expect(serializeSchema({ User }).tables.User.indexes.User_email_idx.where).toBe('"email" IS NOT NULL');
  });

  it('includes user triggers', () => {
    const User = defineTable('User', { email: v.string() });
    defineTrigger('User_audit', { timing: 'AFTER', event: 'INSERT', on: User, body: 'RETURN NULL;' });
    expect(serializeSchema({ User }).tables.User.triggers.User_audit).toEqual({
      name: 'User_audit', timing: 'AFTER', event: 'INSERT', tableName: 'User', body: 'RETURN NULL;',
    });
  });

  it('skips exports that are not tables', () => {
    expect(serializeSchema({ foo: 'bar', count: 42, fn: () => {} }).tables).toEqual({});
  });

  it('keeps column defaults', () => {
    const T = defineTable('T', { role: withDefault(v.string(), 'user') });
    expect(serializeSchema({ T }).tables.T.columns.role.default).toBe("'user'");
  });

  it('defaults foreign key refColumns to the primary key of the other table', () => {
    const User = defineTable('User', { email: v.string() });
    const Post = defineTable('Post', { userId: v.bigint() }, {
      foreignKeys: [{ columns: ['userId'], references: User, onDelete: 'CASCADE' }],
    });
    expect(serializeSchema({ User, Post }).tables.Post.foreignKeys.userId).toEqual({
      name: 'Post_userId_fkey', columns: ['userId'], refTable: 'User', refColumns: ['id'], onDelete: 'CASCADE',
    });
  });

  it('follows the other table primaryKeyColumn for refColumns', () => {
    const User = defineTable('User', { email: v.string() }, { primaryKeyColumn: 'pk' });
    const Post = defineTable('Post', { userId: v.bigint() }, {
      foreignKeys: [{ columns: ['userId'], references: User }],
    });
    expect(serializeSchema({ Post }).tables.Post.foreignKeys.userId.refColumns).toEqual(['pk']);
  });

  it('keeps the deferrable setting of a foreign key', () => {
    const User = defineTable('User', { email: v.string() });
    const Post = defineTable('Post', { userId: v.bigint() }, {
      foreignKeys: [{ columns: ['userId'], references: User, deferrable: 'deferred' }],
    });
    expect(serializeSchema({ User, Post }).tables.Post.foreignKeys.userId).toEqual({
      name: 'Post_userId_fkey', columns: ['userId'], refTable: 'User', refColumns: ['id'], deferrable: 'deferred',
    });
    const Plain = defineTable('Plain', { userId: v.bigint() }, { foreignKeys: [{ columns: ['userId'], references: User }] });
    expect('deferrable' in serializeSchema({ Plain }).tables.Plain.foreignKeys.userId!).toBe(false);
  });

  it('skips a foreign key with no refColumns and no primary key', () => {
    const User = defineTable('User', { email: v.string() }, { primaryKey: false });
    const Post = defineTable('Post', { userId: v.bigint() }, {
      foreignKeys: [{ columns: ['userId'], references: User }],
    });
    expect(serializeSchema({ Post }).tables.Post.foreignKeys).toEqual({});
  });
});

describe('defineCheck and defineForeignKey', () => {
  it('stores a check under the table name', () => {
    const Item = defineTable('Item', { qty: v.pipe(v.number(), v.integer()) });
    defineCheck(Item, 'positive', '"qty" >= 0');
    expect(serializeSchema({ Item }).tables.Item.checks).toEqual({
      Item_positive_check: { name: 'Item_positive_check', sql: '"qty" >= 0' },
    });
  });

  it('refuses a check named like a picklist check', () => {
    const Item = defineTable('Item', { kind: v.picklist(['a', 'b']) });
    defineCheck(Item, 'kind', '"kind" <> \'a\'');
    expect(() => serializeSchema({ Item })).toThrow('two checks named "Item_kind_check"');
  });

  it('lets a table point to itself', () => {
    const Node = defineTable('Node', { parentId: v.nullable(v.bigint()) });
    defineForeignKey(Node, { columns: ['parentId'], references: Node, onDelete: 'CASCADE' });
    expect(serializeSchema({ Node }).tables.Node.foreignKeys.parentId).toEqual({
      name: 'Node_parentId_fkey',
      columns: ['parentId'],
      refTable: 'Node',
      refColumns: ['id'],
      onDelete: 'CASCADE',
    });
  });

  it('indexes a built-in column', () => {
    const Item = defineTable('Item', { versionId: v.bigint() });
    defineIndex(Item, ['versionId', 'id'], { unique: true });
    expect(serializeSchema({ Item }).tables.Item.indexes.Item_versionId_id_uq.columns).toEqual(['versionId', 'id']);
  });
});
