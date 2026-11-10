# Changelog

## 0.3.0 (2026-11-10)

- Add `defineCheck(table, name, sql)` for a `CHECK` on the whole table. A check added to an existing table goes in as `NOT VALID` with a `_validate.sql` file. Renaming the table renames the check.
- Add `defineForeignKey(table, key)`, so a table can point to itself.
- `defineIndex` takes the built-in columns, like `id`, in its column list.

## 0.2.1 (2026-11-09)

- `schema.json`, migrations and `schema.sql` list tables in the order `schema.ts` defines them. They were in alphabetical order, because JavaScript sorts module exports by name.

## 0.2.0 (2026-11-09)

- Add `numeric(precision, scale)` for `v.decimal()` columns. It writes `numeric(18,2)` instead of `numeric`.
- Write a named `CHECK` for each `v.picklist` column, so Postgres refuses other values. Removing a value writes a new `limits` warning. Renaming the column or table renames the check.
- A check added to an existing table goes in as `NOT VALID`. `schema:diff` writes a second `_validate.sql` file that runs `VALIDATE CONSTRAINT` in its own transaction, so old rows are checked without blocking writes.
- All tables share one `updatedAt` trigger function, `kyt_set_updatedAt`. The next `schema:diff` moves each old per-table function to it.
- `defineIndex` and foreign key `columns` and `refColumns` take readonly arrays, so `as const` lists work.

## 0.1.3 (2026-11-01)

- Map `v.pipe(v.string(), v.decimal())` to `numeric` and `v.pipe(v.string(), v.isoDate())` to `date`. Both were `text` before.

## 0.1.2 (2026-10-24)

- Add npm, CI and license badges to the README.
- Ship the MIT `LICENSE` file in the package.

## 0.1.1 (2026-10-18)

- Add the `repository` field, so npm links to `packages/kyt-pg` in the `sher/kyt` repo.

## 0.1.0 (2026-10-18)

First release.

- Define tables, indexes, triggers and foreign keys with Valibot.
- Add typed Kysely queries that only compile. postgres.js runs them.
- Add read-only virtual tables.
- Add `queryAll`, `queryFirst`, `queryRun` and `queryBatch`.
- Add the `kyt-pg` command with `init` and `schema:diff`.
- Ask about renames, or pass `--rename` and `--no-rename`.
- Add warnings for changes that can fail on a table with rows.
- Add `migrate` in `kyt-pg/migrate`. It uses one transaction for each file and an advisory lock.
- `migrate` runs each file at `read committed`, whatever the database default is.
- `migrate` refuses a new file that holds `BEGIN`, `COMMIT`, `END`, `ROLLBACK` or `START TRANSACTION`.
- Dropping a table also drops its trigger functions.
- A default that cannot be written, such as `NaN` or a `bigint` inside jsonb, fails with the table and column name.
- Foreign keys take `deferrable: 'immediate' | 'deferred'`. A change to only that setting becomes `ALTER CONSTRAINT`.
