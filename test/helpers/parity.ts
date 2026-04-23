import { expect } from "vitest"

import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { sumak } from "../../src/sumak.ts"
import type { CompiledQuery, SQLDialect } from "../../src/types.ts"

/**
 * Cross-dialect parity test helper.
 *
 * Takes a builder function (one that accepts a typed `db` and returns an
 * object with `.toSQL()` or `.compile()`) plus a per-dialect expectation
 * map, then runs the same builder against all four dialects and checks
 * each against its expected output.
 *
 * ### Expectation values
 *
 * For each dialect, pass one of:
 * - `{ sql: string, params?: unknown[] }` — compiled SQL must match
 *   exactly (trailing whitespace stripped). When `params` is omitted,
 *   only the SQL is compared.
 * - `string` — shorthand for `{ sql }`.
 * - `{ throws: RegExp | string | typeof Error }` — the builder must
 *   throw, and the message / error class must match.
 * - `undefined` — this dialect is ignored (e.g. "not relevant here").
 *
 * ### When to use
 *
 * Any time a feature has cross-dialect surface area — adding it to
 * parity coverage proves that either (a) all dialects agree on the
 * same semantic shape or (b) unsupported dialects throw a helpful
 * `UnsupportedDialectFeatureError` instead of silently emitting
 * broken SQL. It is the primary preventative for the audit-round
 * churn that gave us rounds #1–#24.
 */

export type ParityExpectation =
  | string
  | { sql: string; params?: readonly unknown[] }
  | { throws: RegExp | string | (new (...args: any[]) => Error) }
  | undefined

export type ParityMatrix = Partial<Record<SQLDialect, ParityExpectation>>

type TablesShape = Parameters<typeof sumak>[0]["tables"]

const DIALECT_FACTORIES = {
  pg: pgDialect,
  mysql: mysqlDialect,
  sqlite: sqliteDialect,
  mssql: mssqlDialect,
} as const

/**
 * Run `build(db)` against each dialect listed in `matrix` and assert
 * every one matches its declared expectation.
 *
 * ```ts
 * assertParity(
 *   (db) => db.selectFrom("users").select("id").where(({ id }) => id.eq(1)),
 *   { users: { id: serial().primaryKey() } },
 *   {
 *     pg: { sql: `SELECT "id" FROM "users" WHERE ("id" = $1)`, params: [1] },
 *     mysql: { sql: "SELECT `id` FROM `users` WHERE (`id` = ?)", params: [1] },
 *     sqlite: { sql: `SELECT "id" FROM "users" WHERE ("id" = ?)`, params: [1] },
 *     mssql: { sql: `SELECT [id] FROM [users] WHERE ([id] = @p0)`, params: [1] },
 *   },
 * )
 * ```
 */
export function assertParity<T extends TablesShape>(
  build: (db: ReturnType<typeof sumak<T>>) => { toSQL: () => CompiledQuery },
  tables: T,
  matrix: ParityMatrix,
): void {
  for (const [dialect, expected] of Object.entries(matrix) as [SQLDialect, ParityExpectation][]) {
    if (expected === undefined) continue
    const db = sumak({ dialect: DIALECT_FACTORIES[dialect](), tables })
    runOne(dialect, () => build(db), expected)
  }
}

/**
 * Lower-level variant: accepts an already-built query object (so you
 * don't have to rebuild four times when the builder itself is the
 * cross-dialect part). The caller is responsible for running the
 * builder against each dialect.
 *
 * ```ts
 * runPerDialect((db) => db.selectFrom("users").selectAll(), { users: {...} }, {
 *   pg: (qb) => expect(qb.toSQL().sql).toContain(`"users"`),
 *   mysql: (qb) => expect(qb.toSQL().sql).toContain("`users`"),
 * })
 * ```
 */
export function runPerDialect<T extends TablesShape, B>(
  build: (db: ReturnType<typeof sumak<T>>) => B,
  tables: T,
  per: Partial<Record<SQLDialect, (qb: B) => void>>,
): void {
  for (const [dialect, assertion] of Object.entries(per) as [SQLDialect, (qb: B) => void][]) {
    const db = sumak({ dialect: DIALECT_FACTORIES[dialect](), tables })
    assertion(build(db) as B)
  }
}

function runOne(
  dialect: SQLDialect,
  build: () => { toSQL: () => CompiledQuery },
  expected: Exclude<ParityExpectation, undefined>,
): void {
  const isThrows = typeof expected === "object" && expected !== null && "throws" in expected

  if (isThrows) {
    const { throws } = expected as { throws: RegExp | string | (new (...args: any[]) => Error) }
    try {
      const qb = build()
      // Some throws happen at compile time, not at build time.
      qb.toSQL()
      throw new AssertionError(
        `[${dialect}] expected the builder (or its compile step) to throw, but it returned a compiled query`,
      )
    } catch (err) {
      if (err instanceof AssertionError) throw err
      if (throws instanceof RegExp) {
        expect((err as Error).message, `[${dialect}] error message mismatch`).toMatch(throws)
      } else if (typeof throws === "string") {
        expect((err as Error).message, `[${dialect}] error message mismatch`).toContain(throws)
      } else {
        expect(err, `[${dialect}] error class mismatch`).toBeInstanceOf(throws)
      }
    }
    return
  }

  const exp = typeof expected === "string" ? { sql: expected } : expected
  const qb = build()
  const out = qb.toSQL()
  expect(normalize(out.sql), `[${dialect}] SQL mismatch`).toBe(normalize(exp.sql))
  if (exp.params !== undefined) {
    expect([...out.params], `[${dialect}] params mismatch`).toEqual([...exp.params])
  }
}

function normalize(sql: string): string {
  return sql.trim().replace(/\s+/g, " ")
}

class AssertionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AssertionError"
  }
}
