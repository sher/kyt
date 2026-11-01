# Changelog

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
