# kyt-pg

[![npm](https://img.shields.io/npm/v/kyt-pg)](https://www.npmjs.com/package/kyt-pg) [![CI](https://github.com/sher/kyt/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sher/kyt/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/kyt-pg)](https://github.com/sher/kyt/blob/main/packages/kyt-pg/LICENSE)

Write your Postgres schema with Valibot. Get typed Kysely queries and SQL migrations from it.

kyt-pg only builds queries and writes SQL. Your app runs them with postgres.js.

## Install

```sh
npm install kyt-pg kysely valibot postgres
```

## Set up postgres.js

Create the client with the bigint type. Every table gets a bigint `id` by default.

```ts
import postgres from 'postgres';

export const sql = postgres(process.env.DATABASE_URL!, {
  types: { bigint: postgres.BigInt },
});
```

Without this option, postgres.js returns bigint values as strings.

postgres.js returns `numeric` as a string, which matches `v.decimal()`. It turns `date` into a JS `Date` by default. Keep it a `YYYY-MM-DD` string, as `v.isoDate()` expects:

```ts
export const sql = postgres(process.env.DATABASE_URL!, {
  types: {
    bigint: postgres.BigInt,
    day: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x },
  },
});
```

`JSON.stringify` throws on a bigint. Turn ids into strings or numbers before you send JSON.

```ts
JSON.stringify({ id: String(user.id) });
```

jsonb needs no extra work. postgres.js sends plain objects and arrays to jsonb columns as JSON. It parses jsonb on read.

## Workflow

1. Run `npx kyt-pg init`. It adds `db/config.ts`, `db/schema.ts` and `db/schema.json`.
2. Define your tables in `db/schema.ts`.
3. Run `npx kyt-pg schema:diff createUser`. It writes a `.sql` file to `db/migrations`.
4. Read the file. Fix any `-- WARNING:` line.
5. Run the file with `migrate` (see "Run migrations").

`schema:diff` also writes `db/schema.sql`. It holds the full schema, and it is for reading only.

```ts
// db/schema.ts
import * as v from 'valibot';
import { defineTable, defineIndex, withDefault, defineVirtualTable, createQueryBuilder } from 'kyt-pg';
import type { InferDB } from 'kyt-pg';

export const User = defineTable('User', {
  email: v.string(),
  fullName: v.nullable(v.string()),
  isActive: withDefault(v.boolean(), true),
});
defineIndex(User, ['email'], { unique: true });

export const Post = defineTable(
  'Post',
  { authorId: v.bigint(), title: v.string(), published: withDefault(v.boolean(), false) },
  { foreignKeys: [{ columns: ['authorId'], references: User, onDelete: 'CASCADE' }] },
);

export const PublishedPost = defineVirtualTable('PublishedPost', Post, ['authorId', 'title'], {
  where: { published: true },
});

export type DB = InferDB<{
  User: typeof User;
  Post: typeof Post;
  PublishedPost: typeof PublishedPost;
}>;

export const db = createQueryBuilder<DB>([PublishedPost]);
```

Foreign keys are added after all tables are created, so any order works. The SQL lists tables in the order `schema.ts` defines them.

A virtual table is a typed view. It adds no table and needs no migration. It is read-only.

## Type mapping

| Valibot | Postgres |
|---|---|
| `v.string()` | `text` |
| `v.pipe(v.string(), v.uuid())` | `uuid` |
| `v.pipe(v.string(), v.decimal())` | `numeric` |
| `v.pipe(v.string(), v.decimal(), numeric(18, 2))` | `numeric(18,2)` |
| `v.pipe(v.string(), v.isoDate())` | `date` |
| `v.number()` | `double precision` |
| `v.pipe(v.number(), v.integer())` | `integer` |
| `v.bigint()` | `bigint` |
| `v.boolean()` | `boolean` |
| `v.object(...)`, `v.array(...)` | `jsonb` |
| `v.date()` | `timestamptz` |
| `v.picklist([...])` | `text` with a `CHECK` on the values |
| `v.nullable(x)` | the type of `x`, without `NOT NULL` |

Every other column is `NOT NULL`. Use `withDefault(schema, value)` to set a default. Use `sqlDefault('now()')` for a SQL default.

`numeric(precision, scale)` comes from `kyt-pg`. Put it last in the pipe, after `v.decimal()`. Postgres then rounds each value to `scale` places. The scale defaults to 0.

A picklist check is named `<Table>_<column>_check`.

When a check changes on a table that already exists, `schema:diff` writes two files:

1. `<n>_<name>.sql` adds the new check as `NOT VALID`. Postgres checks new rows at once and does not read the old ones, so the lock is short.
2. `<n+1>_<name>_validate.sql` runs `VALIDATE CONSTRAINT`. It reads the old rows without blocking writes, because `migrate` runs it in its own transaction.

Adding a value to the list needs no warning. Removing a value writes the `limits` warning in the validate file.

## Built-in columns

Each table gets three columns. You do not define them.

- `id`, the primary key.
- `createdAt`, set on insert.
- `updatedAt`, set on insert and kept current by a trigger. All tables share one trigger function, `kyt_set_updatedAt`.

Set the `id` type for each table with the `id` option. The default is `bigint`.

```ts
defineTable('Tag', { label: v.string() }, { id: 'uuid' });
defineTable('Color', { label: v.string() }, { id: 'integer' });
```

The `id` option takes `'bigint'`, `'integer'` or `'uuid'`. A uuid table makes its own ids. The other two count up.

There is no setting for this in `config.ts`. Types cannot read a config file.

Other table options are `primaryKey`, `createdAt`, `updatedAt`, `primaryKeyColumn`, `createdAtColumn` and `updatedAtColumn`.

## Foreign keys

A foreign key takes `columns`, `references`, and the optional `refColumns`, `onDelete`, `onUpdate` and `deferrable`.

```ts
const Item = defineTable('Item', { orderId: v.bigint() }, {
  foreignKeys: [{ columns: ['orderId'], references: Order, deferrable: 'deferred' }],
});
```

`deferrable` decides when Postgres checks the key:

| Value | SQL | When Postgres checks |
|---|---|---|
| not set | `NOT DEFERRABLE` | after each statement |
| `'immediate'` | `DEFERRABLE INITIALLY IMMEDIATE` | after each statement, unless the transaction runs `set constraints all deferred` |
| `'deferred'` | `DEFERRABLE INITIALLY DEFERRED` | at commit |

A deferred key lets one transaction insert rows in any order, such as a child before its parent. A row with no parent still fails at commit.

If you change only `deferrable`, `schema:diff` writes `ALTER CONSTRAINT`. It does not drop and add the key again.

## Naming style

Name tables in PascalCase and in the singular, like `User` and `PublishedPost`. Name columns in camelCase, like `fullName`.

kyt-pg uses your names as written. It quotes every name in the SQL it writes. Write raw SQL with quotes too: `select "fullName" from "User"`.

## Query helpers

`db` builds a query. A helper runs it with your postgres.js client.

```ts
import { queryAll, queryFirst, queryRun, queryBatch } from 'kyt-pg';
import { db } from './db/schema.ts';
import { sql } from './sql.ts';

const users = await queryAll(sql, db.selectFrom('User').select(['id', 'email']).compile());

const user = await queryFirst(sql, db.selectFrom('User').selectAll().where('email', '=', 'a@x.io').compile());

const { count } = await queryRun(sql, db.insertInto('User').values({ email: 'a@x.io' }).compile());

await queryBatch(sql, [
  db.insertInto('User').values({ email: 'b@x.io' }).compile(),
  db.insertInto('User').values({ email: 'c@x.io' }).compile(),
]);
```

- `queryAll` returns an array of rows.
- `queryFirst` returns the first row, or `undefined` when there is none.
- `queryRun` returns `{ count }`, the number of rows changed.
- `queryBatch` runs the queries in one transaction. It returns one `{ count }` for each query.

## schema:diff

```sh
npx kyt-pg schema:diff [name] [--dir <dir>] [--schema <path>] [--rename <x>]... [--no-rename]
```

The command compares `schema.ts` with `schema.json` and writes the change as SQL. It then updates `schema.json`.

The file has no `BEGIN` or `COMMIT`. The runner runs each file and its `KytMigration` row in one transaction.

Some changes can break on a table that has rows. kyt-pg writes a `-- WARNING:` line above the SQL for those. There are seven:

- `-- WARNING: adds NOT NULL column "<Table>"."<column>" with no default. This fails if the table has rows. Add a default, or add the column as nullable and fill it first.`
- `-- WARNING: drops column "<Table>"."<column>" and its data. If this is a rename, run schema:diff again and answer yes.`
- `-- WARNING: changes "<Table>"."<column>" from <old type> to <new type>. This fails if any row cannot be cast. Change the USING part if needed.`
- `-- WARNING: makes "<Table>"."<column>" NOT NULL. This fails if any row holds NULL. Fill those rows first.`
- `-- WARNING: the primary key of "<Table>" changed. kyt-pg does not write this change. Write it by hand.`
- `-- WARNING: limits "<Table>"."<column>" to <values>. This fails if any row holds another value. Change those rows first.`
- `-- WARNING: drops table "<Table>" and all its rows. Keep this only if the data is not needed.`

Fix each warning in the file before you run it.

## Renames

A renamed column looks like a drop and an add. That loses data. kyt-pg finds possible renames and asks.

In a terminal, the CLI asks one question for each possible rename. Answer `y` to keep the data.

Without a terminal, the CLI cannot ask. Pass a flag instead.

- `--rename <Table>=<NewTable>` renames a table.
- `--rename <Table>.<old>=<new>` renames a column.
- `--no-rename` treats every possible rename as a drop and an add.

```sh
npx kyt-pg schema:diff --rename User.name=fullName
```

Repeat `--rename` for each rename. A `--rename` that matches nothing stops with an error. Without a terminal, a possible rename that has no flag also stops with an error.

## Run migrations

`migrate` runs every new `.sql` file in name order. It comes from `kyt-pg/migrate`.

```ts
import postgres from 'postgres';
import { migrate } from 'kyt-pg/migrate';

const sql = postgres(process.env.DATABASE_URL!, { types: { bigint: postgres.BigInt } });

try {
  const { applied, skipped } = await migrate(sql, { dir: './db/migrations' });
  console.log(`applied ${applied.length}, skipped ${skipped.length}`);
} finally {
  await sql.end();
}
```

- It adds a `KytMigration` table to track each file.
- It runs each file and its `KytMigration` row in one transaction, under `pg_advisory_xact_lock`. Two runners cannot clash.
- Each transaction uses `read committed`, even if your database defaults to `repeatable read` or `serializable`.
- It refuses a new file that holds `BEGIN`, `COMMIT`, `END`, `ROLLBACK` or `START TRANSACTION`. Those would end the transaction partway through the file. Comments, quoted text and `$$` function bodies are skipped, so trigger functions are fine.
- It stops with an error when a file changed after it ran. Add a new migration instead.

## Cloud Run job

Run migrations as a job before you deploy the service. The job needs the migration files and `DATABASE_URL`.

```ts
// migrate-job.ts
import postgres from 'postgres';
import { migrate } from 'kyt-pg/migrate';

const sql = postgres(process.env.DATABASE_URL!, { types: { bigint: postgres.BigInt } });

try {
  await migrate(sql, { dir: new URL('./db/migrations', import.meta.url).pathname });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await sql.end();
}
```

```dockerfile
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY migrate-job.ts ./
COPY db/migrations ./db/migrations
CMD ["node", "migrate-job.ts"]
```

```sh
gcloud run jobs deploy migrate --source . --set-secrets DATABASE_URL=database-url:latest
gcloud run jobs execute migrate --wait
```

Node 24 runs `.ts` files with built-in type stripping.

## API

From `kyt-pg`:

- `defineTable(name, columns, options?)`
- `defineIndex(table, columns, options?)`
- `defineTrigger(name, options)`
- `defineVirtualTable(name, source, columns, options?)`
- `withDefault(schema, value)`, `sqlDefault(sql)`, `numeric(precision, scale?)`
- `createQueryBuilder<DB>(virtualTables?)`
- `queryAll`, `queryFirst`, `queryRun`, `queryBatch`
- `serializeSchema`, `diffSnapshots`, `findRenameCandidates`, `applyRenames`, `diffToSQL`
- `defineConfig`
- Types: `InferDB`, `InferSelect`, `InferInsert`, `SchemaTable`, `VirtualTable`, `SchemaSnapshot`, `SchemaDiff`, `Rename`

From `kyt-pg/migrate`:

- `migrate(sql, { dir, log? })`. It returns `{ applied, skipped }`.

The `kyt-pg` command has two parts: `init [--dir <dir>]` and `schema:diff`.
