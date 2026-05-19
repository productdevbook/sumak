import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { analyze, reindex, vacuum } from "../../src/index.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "../integration/pglite-driver.ts"

describe("VACUUM — builder shape", () => {
  it("vacuum() wraps a bare node", () => {
    const node = vacuum().build()
    expect(node).toEqual({ type: "vacuum", tables: undefined })
  })

  it(".table(name) restricts to a single table", () => {
    const node = vacuum().table("users").build()
    expect(node.tables).toEqual(["users"])
  })

  it(".tables(...) carries the full list", () => {
    const node = vacuum().tables("users", "orders", "audit_log").build()
    expect(node.tables).toEqual(["users", "orders", "audit_log"])
  })

  it("fluent chain — every option together", () => {
    const node = vacuum()
      .table("users")
      .full()
      .freeze()
      .verbose()
      .analyze()
      .skipLocked()
      .truncate(false)
      .build()
    expect(node).toMatchObject({
      tables: ["users"],
      full: true,
      freeze: true,
      verbose: true,
      analyze: true,
      skipLocked: true,
      truncate: false,
    })
  })

  it(".table() replaces a previous .tables(...) list", () => {
    const node = vacuum().tables("a", "b").table("c").build()
    expect(node.tables).toEqual(["c"])
  })

  it("builder.build() returns an independent copy of the tables array", () => {
    const b = vacuum().tables("a", "b")
    const node = b.build()
    node.tables!.push("c")
    const fresh = b.build()
    expect(fresh.tables).toEqual(["a", "b"])
  })
})

describe("VACUUM — PG emission", () => {
  const db = sumak({ dialect: pgDialect(), tables: {} })

  it("bare statement (database-wide)", () => {
    expect(db.compileDDL(vacuum().build()).sql).toBe("VACUUM")
  })

  it("single-table", () => {
    expect(db.compileDDL(vacuum().table("users").build()).sql).toBe('VACUUM "users"')
  })

  it("multi-table", () => {
    expect(db.compileDDL(vacuum().tables("users", "orders").build()).sql).toBe(
      'VACUUM "users", "orders"',
    )
  })

  it("VACUUM (ANALYZE) — combined", () => {
    expect(db.compileDDL(vacuum().analyze().table("users").build()).sql).toBe(
      'VACUUM (ANALYZE) "users"',
    )
  })

  it("VACUUM (FULL)", () => {
    expect(db.compileDDL(vacuum().full().table("users").build()).sql).toBe('VACUUM (FULL) "users"')
  })

  it("VACUUM (FULL, VERBOSE)", () => {
    expect(db.compileDDL(vacuum().full().verbose().table("users").build()).sql).toBe(
      'VACUUM (FULL, VERBOSE) "users"',
    )
  })

  it("VACUUM (FREEZE, ANALYZE)", () => {
    expect(db.compileDDL(vacuum().freeze().analyze().table("users").build()).sql).toBe(
      'VACUUM (FREEZE, ANALYZE) "users"',
    )
  })

  it("VACUUM (SKIP_LOCKED)", () => {
    expect(db.compileDDL(vacuum().skipLocked().table("users").build()).sql).toBe(
      'VACUUM (SKIP_LOCKED) "users"',
    )
  })

  it("VACUUM (TRUNCATE) — explicit true", () => {
    expect(db.compileDDL(vacuum().truncate().table("users").build()).sql).toBe(
      'VACUUM (TRUNCATE) "users"',
    )
  })

  it("VACUUM (TRUNCATE FALSE) — opt out", () => {
    expect(db.compileDDL(vacuum().truncate(false).table("users").build()).sql).toBe(
      'VACUUM (TRUNCATE FALSE) "users"',
    )
  })

  it("VACUUM (FULL, FREEZE, VERBOSE, ANALYZE, SKIP_LOCKED, TRUNCATE) — every flag", () => {
    const q = db.compileDDL(
      vacuum().full().freeze().verbose().analyze().skipLocked().truncate().table("users").build(),
    )
    expect(q.sql).toBe('VACUUM (FULL, FREEZE, VERBOSE, ANALYZE, SKIP_LOCKED, TRUNCATE) "users"')
  })

  it("options without table list", () => {
    expect(db.compileDDL(vacuum().analyze().build()).sql).toBe("VACUUM (ANALYZE)")
  })

  it("via db.schema.vacuum()", () => {
    const q = db.compileDDL(db.schema.vacuum().analyze().table("users").build())
    expect(q.sql).toBe('VACUUM (ANALYZE) "users"')
  })
})

describe("VACUUM — non-PG refusal", () => {
  it("MySQL refuses", () => {
    const db = sumak({ dialect: mysqlDialect(), tables: {} })
    expect(() => db.compileDDL(vacuum().table("users").build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })

  it("SQLite refuses", () => {
    const db = sumak({ dialect: sqliteDialect(), tables: {} })
    expect(() => db.compileDDL(vacuum().build())).toThrow(UnsupportedDialectFeatureError)
  })

  it("MSSQL refuses", () => {
    const db = sumak({ dialect: mssqlDialect(), tables: {} })
    expect(() => db.compileDDL(vacuum().table("users").build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })
})

describe("ANALYZE — builder shape", () => {
  it("analyze() wraps a bare node", () => {
    const node = analyze().build()
    expect(node).toEqual({ type: "analyze", tables: undefined })
  })

  it(".table(name) restricts to a single table", () => {
    const node = analyze().table("users").build()
    expect(node.tables).toEqual(["users"])
  })

  it(".tables(...) carries the list", () => {
    const node = analyze().tables("users", "orders").build()
    expect(node.tables).toEqual(["users", "orders"])
  })

  it("fluent chain — verbose + skipLocked", () => {
    const node = analyze().table("users").verbose().skipLocked().build()
    expect(node).toMatchObject({
      tables: ["users"],
      verbose: true,
      skipLocked: true,
    })
  })
})

describe("ANALYZE — PG emission", () => {
  const db = sumak({ dialect: pgDialect(), tables: {} })

  it("bare statement (database-wide)", () => {
    expect(db.compileDDL(analyze().build()).sql).toBe("ANALYZE")
  })

  it("single-table", () => {
    expect(db.compileDDL(analyze().table("users").build()).sql).toBe('ANALYZE "users"')
  })

  it("multi-table", () => {
    expect(db.compileDDL(analyze().tables("users", "orders").build()).sql).toBe(
      'ANALYZE "users", "orders"',
    )
  })

  it("ANALYZE (VERBOSE)", () => {
    expect(db.compileDDL(analyze().verbose().table("users").build()).sql).toBe(
      'ANALYZE (VERBOSE) "users"',
    )
  })

  it("ANALYZE (SKIP_LOCKED)", () => {
    expect(db.compileDDL(analyze().skipLocked().table("users").build()).sql).toBe(
      'ANALYZE (SKIP_LOCKED) "users"',
    )
  })

  it("ANALYZE (VERBOSE, SKIP_LOCKED)", () => {
    expect(db.compileDDL(analyze().verbose().skipLocked().table("users").build()).sql).toBe(
      'ANALYZE (VERBOSE, SKIP_LOCKED) "users"',
    )
  })

  it("via db.schema.analyze()", () => {
    const q = db.compileDDL(db.schema.analyze().table("users").build())
    expect(q.sql).toBe('ANALYZE "users"')
  })
})

describe("ANALYZE — non-PG refusal", () => {
  it("MySQL refuses", () => {
    const db = sumak({ dialect: mysqlDialect(), tables: {} })
    expect(() => db.compileDDL(analyze().table("users").build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })

  it("SQLite refuses", () => {
    const db = sumak({ dialect: sqliteDialect(), tables: {} })
    expect(() => db.compileDDL(analyze().build())).toThrow(UnsupportedDialectFeatureError)
  })

  it("MSSQL refuses", () => {
    const db = sumak({ dialect: mssqlDialect(), tables: {} })
    expect(() => db.compileDDL(analyze().table("users").build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })
})

describe("REINDEX — builder shape", () => {
  it("reindex(target, name) wraps a node", () => {
    const node = reindex("TABLE", "users").build()
    expect(node).toEqual({ type: "reindex", target: "TABLE", name: "users" })
  })

  it(".concurrently() flips the flag", () => {
    const node = reindex("TABLE", "users").concurrently().build()
    expect(node.concurrently).toBe(true)
  })

  it(".verbose() flips the flag", () => {
    const node = reindex("INDEX", "idx").verbose().build()
    expect(node.verbose).toBe(true)
  })

  it(".target() replaces the target keyword", () => {
    const node = reindex("TABLE", "users").target("INDEX").build()
    expect(node.target).toBe("INDEX")
  })

  it(".name() replaces the name", () => {
    const node = reindex("TABLE", "users").name("orders").build()
    expect(node.name).toBe("orders")
  })

  it("fluent chain — every option together", () => {
    const node = reindex("TABLE", "users").concurrently().verbose().build()
    expect(node).toMatchObject({
      target: "TABLE",
      name: "users",
      concurrently: true,
      verbose: true,
    })
  })
})

describe("REINDEX — PG emission", () => {
  const db = sumak({ dialect: pgDialect(), tables: {} })

  it("REINDEX INDEX <name>", () => {
    const q = db.compileDDL(reindex("INDEX", "users_email_idx").build())
    expect(q.sql).toBe('REINDEX INDEX "users_email_idx"')
  })

  it("REINDEX TABLE <name>", () => {
    const q = db.compileDDL(reindex("TABLE", "users").build())
    expect(q.sql).toBe('REINDEX TABLE "users"')
  })

  it("REINDEX SCHEMA <name>", () => {
    const q = db.compileDDL(reindex("SCHEMA", "public").build())
    expect(q.sql).toBe('REINDEX SCHEMA "public"')
  })

  it("REINDEX DATABASE <name>", () => {
    const q = db.compileDDL(reindex("DATABASE", "shop").build())
    expect(q.sql).toBe('REINDEX DATABASE "shop"')
  })

  it("REINDEX SYSTEM <name>", () => {
    const q = db.compileDDL(reindex("SYSTEM", "shop").build())
    expect(q.sql).toBe('REINDEX SYSTEM "shop"')
  })

  it("REINDEX TABLE CONCURRENTLY <name>", () => {
    const q = db.compileDDL(reindex("TABLE", "users").concurrently().build())
    expect(q.sql).toBe('REINDEX TABLE CONCURRENTLY "users"')
  })

  it("REINDEX (VERBOSE) TABLE <name>", () => {
    const q = db.compileDDL(reindex("TABLE", "users").verbose().build())
    expect(q.sql).toBe('REINDEX (VERBOSE) TABLE "users"')
  })

  it("REINDEX (VERBOSE) TABLE CONCURRENTLY <name>", () => {
    const q = db.compileDDL(reindex("TABLE", "users").verbose().concurrently().build())
    expect(q.sql).toBe('REINDEX (VERBOSE) TABLE CONCURRENTLY "users"')
  })

  it("name with mixed case gets quoted", () => {
    const q = db.compileDDL(reindex("TABLE", "MyUsers").build())
    expect(q.sql).toBe('REINDEX TABLE "MyUsers"')
  })

  it("via db.schema.reindex()", () => {
    const q = db.compileDDL(db.schema.reindex("TABLE", "users").concurrently().build())
    expect(q.sql).toBe('REINDEX TABLE CONCURRENTLY "users"')
  })

  it("rejects an unknown target keyword on hand-built AST", () => {
    const bad = { type: "reindex", target: "FOO", name: "users" } as unknown as Parameters<
      typeof db.compileDDL
    >[0]
    expect(() => db.compileDDL(bad)).toThrow(/INDEX \/ TABLE \/ SCHEMA \/ DATABASE \/ SYSTEM/)
  })
})

describe("REINDEX — non-PG refusal", () => {
  it("MySQL refuses", () => {
    const db = sumak({ dialect: mysqlDialect(), tables: {} })
    expect(() => db.compileDDL(reindex("TABLE", "users").build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })

  it("SQLite refuses", () => {
    const db = sumak({ dialect: sqliteDialect(), tables: {} })
    expect(() => db.compileDDL(reindex("TABLE", "users").build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })

  it("MSSQL refuses", () => {
    const db = sumak({ dialect: mssqlDialect(), tables: {} })
    expect(() => db.compileDDL(reindex("TABLE", "users").build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })
})

describe("VACUUM / ANALYZE / REINDEX — PGlite roundtrip", () => {
  let pg: PGlite

  beforeAll(async () => {
    pg = new PGlite()
  })

  afterAll(async () => {
    await pg?.close()
  })

  it("VACUUM ANALYZE on a real table runs without error", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: {} })

    await pg.query(`CREATE TABLE maintenance_vac_test (id serial PRIMARY KEY, val text)`)
    await pg.query(`INSERT INTO maintenance_vac_test (val) VALUES ('a'), ('b'), ('c')`)

    await db.executeCompiledNoRows(
      db.compileDDL(vacuum().table("maintenance_vac_test").analyze().build()),
    )

    // The rows are still there — VACUUM doesn't remove live data.
    const after = await pg.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM maintenance_vac_test`,
    )
    expect(Number(after.rows[0]!.count)).toBe(3)

    await pg.query(`DROP TABLE maintenance_vac_test`)
  })

  it("ANALYZE on a real table runs without error", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: {} })

    await pg.query(`CREATE TABLE maintenance_anl_test (id serial PRIMARY KEY, val text)`)
    await pg.query(`INSERT INTO maintenance_anl_test (val) VALUES ('a'), ('b')`)

    await db.executeCompiledNoRows(db.compileDDL(analyze().table("maintenance_anl_test").build()))

    await pg.query(`DROP TABLE maintenance_anl_test`)
  })

  it("REINDEX TABLE on a real table runs without error", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: {} })

    await pg.query(`CREATE TABLE maintenance_rdx_test (id serial PRIMARY KEY, val text)`)
    await pg.query(`CREATE INDEX maintenance_rdx_idx ON maintenance_rdx_test (val)`)
    await pg.query(`INSERT INTO maintenance_rdx_test (val) VALUES ('a'), ('b')`)

    await db.executeCompiledNoRows(db.compileDDL(reindex("TABLE", "maintenance_rdx_test").build()))

    // Index is still usable.
    const r = await pg.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM maintenance_rdx_test WHERE val = 'a'`,
    )
    expect(Number(r.rows[0]!.count)).toBe(1)

    await pg.query(`DROP TABLE maintenance_rdx_test`)
  })

  it("REINDEX INDEX on a real index runs without error", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: {} })

    await pg.query(`CREATE TABLE maintenance_rdx2_test (id serial PRIMARY KEY, val text)`)
    await pg.query(`CREATE INDEX maintenance_rdx2_idx ON maintenance_rdx2_test (val)`)

    await db.executeCompiledNoRows(db.compileDDL(reindex("INDEX", "maintenance_rdx2_idx").build()))

    await pg.query(`DROP TABLE maintenance_rdx2_test`)
  })
})
