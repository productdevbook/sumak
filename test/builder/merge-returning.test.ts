import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { col, eq, param } from "../../src/ast/expression.ts"
import { brandExpression } from "../../src/ast/typed-expression.ts"
import type { Expression } from "../../src/ast/typed-expression.ts"
import { mergeAction } from "../../src/builder/eb.ts"
import { MergeBuilder } from "../../src/builder/merge.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { MssqlPrinter } from "../../src/printer/mssql.ts"
import { PgPrinter } from "../../src/printer/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

/**
 * Helper to wrap a bare column reference as a typed `Expression`. The
 * `col()` factory in `ast/expression.ts` returns a `ColumnRefNode` for
 * the untyped builder surface; the typed builders consume the brand-
 * wrapped form. This shim keeps the test ergonomics simple without
 * depending on the proxy machinery the typed builders use internally.
 */
function expr<T = unknown>(name: string, table?: string): Expression<T> {
  return brandExpression<T>(col(name, table))
}

function pgPrinter() {
  return new PgPrinter()
}

function mssqlPrinter() {
  return new MssqlPrinter()
}

// ─── AST + printer surface ────────────────────────────────────────────

describe("MergeBuilder.returning (printer surface)", () => {
  it("PG: appends RETURNING <cols> after the WHEN clauses", () => {
    const node = new MergeBuilder()
      .into("users")
      .using("staging", "s")
      .on(eq(col("id", "users"), col("id", "s")))
      .whenMatchedUpdate([{ column: "name", value: col("name", "s") }])
      .returning({ type: "column_ref", column: "id" }, { type: "column_ref", column: "name" })
      .build()

    const r = pgPrinter().print(node)
    // RETURNING must come at the tail, after the WHEN clause.
    expect(r.sql).toMatch(/WHEN MATCHED THEN UPDATE SET .* RETURNING "id", "name"$/s)
  })

  it("PG: RETURNING merge_action() projects the branch token", () => {
    // mergeAction() emits `MERGE_ACTION()` — PG knows this as the
    // standard `merge_action()` function returning 'INSERT' | 'UPDATE'
    // | 'DELETE' inside a MERGE RETURNING. We just verify the surface
    // here; the PGlite roundtrip below verifies the runtime contract.
    const node = new MergeBuilder()
      .into("users")
      .using("staging", "s")
      .on(eq(col("id", "users"), col("id", "s")))
      .whenMatchedUpdate([{ column: "name", value: col("name", "s") }])
      .whenNotMatchedInsert(["name"], [col("name", "s")])
      .returning(
        // mergeAction() returns a wrapped Expression — unwrap into the
        // raw ExpressionNode the printer expects.
        (mergeAction() as any).node,
        { type: "column_ref", column: "id" },
        { type: "column_ref", column: "name" },
      )
      .build()

    const r = pgPrinter().print(node)
    expect(r.sql).toContain("MERGE_ACTION()")
    expect(r.sql).toContain('RETURNING MERGE_ACTION(), "id", "name"')
  })

  it("PG: per-branch WHEN AND conditions still emit RETURNING at the tail", () => {
    const node = new MergeBuilder()
      .into("users")
      .using("staging", "s")
      .on(eq(col("id", "users"), col("id", "s")))
      .whenMatchedUpdate(
        [{ column: "name", value: param(0, "renamed") }],
        eq(col("status", "users"), param(1, "active")),
      )
      .whenNotMatchedInsert(["name"], [param(2, "new")])
      .returning({ type: "column_ref", column: "id" })
      .build()

    const r = pgPrinter().print(node)
    // Tail position — after the last WHEN.
    expect(r.sql).toMatch(/WHEN NOT MATCHED THEN INSERT.* RETURNING "id"$/s)
    // Params are renumbered in walk order (condition for UPDATE,
    // then SET value, then INSERT value).
    expect(r.params).toEqual(["active", "renamed", "new"])
  })

  it("MSSQL: throws UnsupportedDialectFeatureError when RETURNING is set", () => {
    const node = new MergeBuilder()
      .into("users")
      .using("staging", "s")
      .on(eq(col("id", "users"), col("id", "s")))
      .whenMatchedUpdate([{ column: "name", value: param(0, "Bob") }])
      .returning({ type: "column_ref", column: "id" })
      .build()

    expect(() => mssqlPrinter().print(node)).toThrow(/RETURNING on MERGE/i)
  })

  it("MSSQL: bare MERGE (no RETURNING) still works", () => {
    const node = new MergeBuilder()
      .into("users")
      .using("staging", "s")
      .on(eq(col("id", "users"), col("id", "s")))
      .whenMatchedUpdate([{ column: "name", value: param(0, "Bob") }])
      .build()

    // Smoke check — the override only throws when returning is set.
    const r = mssqlPrinter().print(node)
    expect(r.sql).toContain("[users]")
    expect(r.sql).not.toContain("RETURNING")
  })

  it("returning() accumulates across chained calls", () => {
    const node = new MergeBuilder()
      .into("users")
      .using("staging", "s")
      .on(eq(col("id", "users"), col("id", "s")))
      .whenMatchedUpdate([{ column: "name", value: col("name", "s") }])
      .returning({ type: "column_ref", column: "id" })
      .returning({ type: "column_ref", column: "name" })
      .build()

    const r = pgPrinter().print(node)
    expect(r.sql).toContain('RETURNING "id", "name"')
  })
})

// ─── Typed builder surface ────────────────────────────────────────────

const dbForTyped = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      status: text().notNull(),
    },
    staging: {
      id: serial().primaryKey(),
      name: text().notNull(),
      status: text().notNull(),
    },
  },
})

describe("TypedMergeBuilder.returning", () => {
  it("returning('id') projects a single column", () => {
    const q = dbForTyped
      .mergeInto("users", {
        source: "staging",
        alias: "s",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenMatchedThenUpdate({ name: "renamed" })
      .returning("id")
      .toSQL()
    expect(q.sql).toMatch(/RETURNING "id"$/)
  })

  it("returning(...multi cols) projects each in declared order", () => {
    const q = dbForTyped
      .mergeInto("users", {
        source: "staging",
        alias: "s",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenMatchedThenUpdate({ name: "renamed" })
      .returning("id", "name")
      .toSQL()
    expect(q.sql).toMatch(/RETURNING "id", "name"$/)
  })

  it("returning({ alias: expr }) uses aliased-expr shape", () => {
    const q = dbForTyped
      .mergeInto("users", {
        source: "staging",
        alias: "s",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenMatchedThenUpdate({ name: "renamed" })
      .whenNotMatchedThenInsert({ id: 1, name: "new", status: "active" })
      .returning({ action: mergeAction() })
      .toSQL()
    expect(q.sql).toContain('MERGE_ACTION() AS "action"')
  })

  it("returningAll() emits RETURNING *", () => {
    const q = dbForTyped
      .mergeInto("users", {
        source: "staging",
        alias: "s",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenMatchedThenUpdate({ name: "renamed" })
      .returningAll()
      .toSQL()
    expect(q.sql).toContain("RETURNING *")
  })

  it("returning() throws on zero args", () => {
    expect(() =>
      (
        dbForTyped
          .mergeInto("users", {
            source: "staging",
            alias: "s",
            on: ({ target, source }) => target.id.eq(source.id),
          })
          .whenMatchedThenUpdate({ name: "x" }) as any
      ).returning(),
    ).toThrow(/at least one column or expression/i)
  })

  it("returning({}) throws on empty aliased object", () => {
    expect(() =>
      dbForTyped
        .mergeInto("users", {
          source: "staging",
          alias: "s",
          on: ({ target, source }) => target.id.eq(source.id),
        })
        .whenMatchedThenUpdate({ name: "x" })
        .returning({}),
    ).toThrow(/at least one aliased expression/i)
  })
})

// ─── PGlite roundtrip ─────────────────────────────────────────────────

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    CREATE TABLE target_t (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE source_t (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
  `)
})

afterAll(async () => {
  await pg.close()
})

const rtDb = sumak({
  dialect: pgDialect(),
  tables: {
    target_t: {
      id: integer().primaryKey(),
      name: text().notNull(),
      status: text().notNull(),
    },
    source_t: {
      id: integer().primaryKey(),
      name: text().notNull(),
    },
  },
})

describe("PGlite roundtrip — MERGE … RETURNING merge_action(), …", () => {
  it("returns one row per affected target row, tagged with the branch action", async () => {
    // PG 17+ introduced RETURNING on MERGE. PGlite older than that
    // does not parse it; skip rather than fail.
    const versionRes = await pg.query<{ server_version: string }>(`SHOW server_version`)
    const major = parseInt(versionRes.rows[0]?.server_version?.split(".")[0] ?? "0", 10)
    if (major < 17) {
      // eslint-disable-next-line no-console
      console.log(`Skipping PGlite roundtrip — server is PG ${major}, need 17+`)
      return
    }

    await pg.exec(`TRUNCATE target_t, source_t;`)
    await pg.exec(`
      INSERT INTO target_t (id, name, status) VALUES
        (1, 'Alice', 'active'),
        (2, 'Bob', 'active');
      INSERT INTO source_t (id, name) VALUES
        (1, 'Alice-renamed'),
        (3, 'Charlie');
    `)

    // Aliased projection: capture both the branch token and the
    // post-action row identity so the test asserts on a stable shape.
    const q = rtDb
      .mergeInto("target_t", {
        source: "source_t",
        alias: "s",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenMatchedThenUpdate({ name: "merged" })
      .whenNotMatchedThenInsert({ id: 99, name: "from-not-matched", status: "active" })
      .returning({ action: mergeAction() })
      .toSQL()

    const result = await pg.query<{ action: string }>(q.sql, q.params as any[])
    const actions = result.rows.map((r) => r.action).sort()
    // id=1 matched → UPDATE
    // id=3 from source absent in target → INSERT
    // id=2 untouched (no NOT MATCHED BY SOURCE branch)
    expect(actions).toEqual(["INSERT", "UPDATE"])
  })

  it("returning columns work alongside merge_action()", async () => {
    const versionRes = await pg.query<{ server_version: string }>(`SHOW server_version`)
    const major = parseInt(versionRes.rows[0]?.server_version?.split(".")[0] ?? "0", 10)
    if (major < 17) {
      // eslint-disable-next-line no-console
      console.log(`Skipping PGlite roundtrip — server is PG ${major}, need 17+`)
      return
    }

    await pg.exec(`TRUNCATE target_t, source_t;`)
    await pg.exec(`
      INSERT INTO target_t (id, name, status) VALUES (1, 'Alice', 'active');
      INSERT INTO source_t (id, name) VALUES (1, 'Alice-renamed'), (2, 'Bob');
    `)

    const q = rtDb
      .mergeInto("target_t", {
        source: "source_t",
        alias: "s",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenMatchedThenUpdate({ name: "merged" })
      .whenNotMatchedThenInsert({ id: 77, name: "new-row", status: "active" })
      .returning({
        id: expr<number>("id", "target_t"),
        name: expr<string>("name", "target_t"),
        action: mergeAction(),
      })
      .toSQL()

    const { rows } = await pg.query<{ id: number; name: string; action: string }>(
      q.sql,
      q.params as any[],
    )
    const sorted = rows
      .map((r) => ({ id: r.id, name: r.name, action: r.action }))
      .sort((a, b) => a.id - b.id)
    // Two affected rows: target id=1 updated, id=77 inserted.
    expect(sorted).toEqual([
      { id: 1, name: "merged", action: "UPDATE" },
      { id: 77, name: "new-row", action: "INSERT" },
    ])
  })
})
