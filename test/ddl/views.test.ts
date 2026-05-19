import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { unsafeRawExpr } from "../../src/builder/eb.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "../integration/pglite-driver.ts"

const schema = {
  users: {
    id: serial().primaryKey(),
    name: text().notNull(),
    active: integer().notNull(),
  },
}

describe("CREATE VIEW — basic cross-dialect", () => {
  for (const [label, dialect, openQ, closeQ] of [
    ["pg", pgDialect, '"', '"'],
    ["mysql", mysqlDialect, "`", "`"],
    ["sqlite", sqliteDialect, '"', '"'],
    ["mssql", mssqlDialect, "[", "]"],
  ] as const) {
    it(`${label} emits a plain CREATE VIEW with the embedded SELECT`, () => {
      const db = sumak({ dialect: dialect(), tables: schema })
      const sel = db.selectFrom("users").select("id", "name").build()
      const q = db.compileDDL(db.schema.createView("active_users").asSelect(sel).build())
      expect(q.sql).toContain("CREATE VIEW")
      expect(q.sql).toContain(`${openQ}active_users${closeQ}`)
      // Inner SELECT is rendered by the dialect's printer — the
      // identifier quoting should match.
      expect(q.sql).toContain(`${openQ}users${closeQ}`)
      expect(q.sql).toContain(`${openQ}id${closeQ}`)
      expect(q.sql).toContain(`${openQ}name${closeQ}`)
      expect(q.sql).toContain("AS")
      expect(q.sql).toContain("SELECT")
    })
  }
})

describe("CREATE VIEW — OR REPLACE / OR ALTER dialect divergence", () => {
  it("PG emits CREATE OR REPLACE VIEW", () => {
    const db = sumak({ dialect: pgDialect(), tables: schema })
    const sel = db.selectFrom("users").select("id").build()
    const q = db.compileDDL(db.schema.createView("v").orReplace().asSelect(sel).build())
    expect(q.sql).toContain("CREATE OR REPLACE VIEW")
  })

  it("MySQL emits CREATE OR REPLACE VIEW", () => {
    const db = sumak({ dialect: mysqlDialect(), tables: schema })
    const sel = db.selectFrom("users").select("id").build()
    const q = db.compileDDL(db.schema.createView("v").orReplace().asSelect(sel).build())
    expect(q.sql).toContain("CREATE OR REPLACE VIEW")
  })

  it("MSSQL emits CREATE OR ALTER VIEW (via .orAlter())", () => {
    const db = sumak({ dialect: mssqlDialect(), tables: schema })
    const sel = db.selectFrom("users").select("id").build()
    const q = db.compileDDL(db.schema.createView("v").orAlter().asSelect(sel).build())
    expect(q.sql).toContain("CREATE OR ALTER VIEW")
    // The PG/MySQL spelling must NOT appear on MSSQL.
    expect(q.sql).not.toContain("OR REPLACE")
  })

  it("MSSQL refuses .orReplace() with a pointer at .orAlter()", () => {
    const db = sumak({ dialect: mssqlDialect(), tables: schema })
    const sel = db.selectFrom("users").select("id").build()
    expect(() =>
      db.compileDDL(db.schema.createView("v").orReplace().asSelect(sel).build()),
    ).toThrow(/orAlter/)
  })

  it("PG/MySQL/SQLite refuse .orAlter() (MSSQL-only)", () => {
    for (const dialect of [pgDialect, mysqlDialect, sqliteDialect] as const) {
      const db = sumak({ dialect: dialect(), tables: schema })
      const sel = db.selectFrom("users").select("id").build()
      expect(() =>
        db.compileDDL(db.schema.createView("v").orAlter().asSelect(sel).build()),
      ).toThrow(UnsupportedDialectFeatureError)
    }
  })

  it("SQLite refuses .orReplace() with the DROP+CREATE workaround in the message", () => {
    const db = sumak({ dialect: sqliteDialect(), tables: schema })
    const sel = db.selectFrom("users").select("id").build()
    expect(() =>
      db.compileDDL(db.schema.createView("v").orReplace().asSelect(sel).build()),
    ).toThrow(/DROP VIEW/)
  })

  it("setting both .orReplace() and .orAlter() throws", () => {
    const db = sumak({ dialect: pgDialect(), tables: schema })
    const sel = db.selectFrom("users").select("id").build()
    expect(() =>
      db.compileDDL(db.schema.createView("v").orReplace().orAlter().asSelect(sel).build()),
    ).toThrow(/mutually exclusive/)
  })

  it(".orAlter() + .ifNotExists() throws (mutually exclusive)", () => {
    const db = sumak({ dialect: mssqlDialect(), tables: schema })
    const sel = db.selectFrom("users").select("id").build()
    expect(() =>
      db.compileDDL(db.schema.createView("v").orAlter().ifNotExists().asSelect(sel).build()),
    ).toThrow(/mutually exclusive/)
  })
})

describe("CREATE VIEW — IF NOT EXISTS", () => {
  it("PG / MySQL / SQLite emit IF NOT EXISTS", () => {
    for (const dialect of [pgDialect, mysqlDialect, sqliteDialect] as const) {
      const db = sumak({ dialect: dialect(), tables: schema })
      const sel = db.selectFrom("users").select("id").build()
      const q = db.compileDDL(db.schema.createView("v").ifNotExists().asSelect(sel).build())
      expect(q.sql).toContain("IF NOT EXISTS")
    }
  })

  it("MSSQL refuses IF NOT EXISTS on CREATE VIEW (no first-class form)", () => {
    const db = sumak({ dialect: mssqlDialect(), tables: schema })
    const sel = db.selectFrom("users").select("id").build()
    expect(() =>
      db.compileDDL(db.schema.createView("v").ifNotExists().asSelect(sel).build()),
    ).toThrow(UnsupportedDialectFeatureError)
  })
})

describe("CREATE MATERIALIZED VIEW — PG only", () => {
  it("PG emits CREATE MATERIALIZED VIEW", () => {
    const db = sumak({ dialect: pgDialect(), tables: schema })
    const sel = db.selectFrom("users").select("id", "name").build()
    const q = db.compileDDL(db.schema.createView("stats").materialized().asSelect(sel).build())
    expect(q.sql).toContain("CREATE MATERIALIZED VIEW")
    expect(q.sql).toContain('"stats"')
  })

  it("PG emits WITH NO DATA when .withData(false) is set", () => {
    const db = sumak({ dialect: pgDialect(), tables: schema })
    const sel = db.selectFrom("users").select("id").build()
    const q = db.compileDDL(
      db.schema.createView("stats").materialized().withData(false).asSelect(sel).build(),
    )
    expect(q.sql).toContain("WITH NO DATA")
  })

  it("PG omits WITH DATA when .withData(true) (default behavior)", () => {
    const db = sumak({ dialect: pgDialect(), tables: schema })
    const sel = db.selectFrom("users").select("id").build()
    const q = db.compileDDL(
      db.schema.createView("stats").materialized().withData(true).asSelect(sel).build(),
    )
    // PG defaults to WITH DATA, so we don't bother emitting it
    // verbatim — only emit the explicit tail when the user opted into
    // WITH NO DATA.
    expect(q.sql).not.toContain("WITH NO DATA")
    expect(q.sql).not.toContain("WITH DATA")
  })

  it("MySQL / SQLite / MSSQL refuse MATERIALIZED VIEW", () => {
    for (const dialect of [mysqlDialect, sqliteDialect, mssqlDialect] as const) {
      const db = sumak({ dialect: dialect(), tables: schema })
      const sel = db.selectFrom("users").select("id").build()
      expect(() =>
        db.compileDDL(db.schema.createView("v").materialized().asSelect(sel).build()),
      ).toThrow(UnsupportedDialectFeatureError)
    }
  })
})

describe("REFRESH MATERIALIZED VIEW — PG only", () => {
  it("emits the basic form", () => {
    const db = sumak({ dialect: pgDialect(), tables: {} })
    const q = db.compileDDL(db.schema.refreshMaterializedView("daily_stats").build())
    expect(q.sql).toBe('REFRESH MATERIALIZED VIEW "daily_stats"')
  })

  it("emits CONCURRENTLY when .concurrently() is set", () => {
    const db = sumak({ dialect: pgDialect(), tables: {} })
    const q = db.compileDDL(db.schema.refreshMaterializedView("daily_stats").concurrently().build())
    expect(q.sql).toBe('REFRESH MATERIALIZED VIEW CONCURRENTLY "daily_stats"')
  })

  it("emits WITH NO DATA when .withData(false) is set", () => {
    const db = sumak({ dialect: pgDialect(), tables: {} })
    const q = db.compileDDL(db.schema.refreshMaterializedView("stats").withData(false).build())
    expect(q.sql).toBe('REFRESH MATERIALIZED VIEW "stats" WITH NO DATA')
  })

  it("includes the schema qualifier when supplied", () => {
    const db = sumak({ dialect: pgDialect(), tables: {} })
    const q = db.compileDDL(db.schema.refreshMaterializedView("stats", "rpt").build())
    expect(q.sql).toBe('REFRESH MATERIALIZED VIEW "rpt"."stats"')
  })

  it("MySQL / SQLite / MSSQL all refuse REFRESH MATERIALIZED VIEW", () => {
    for (const dialect of [mysqlDialect, sqliteDialect, mssqlDialect] as const) {
      const db = sumak({ dialect: dialect(), tables: {} })
      expect(() => db.compileDDL(db.schema.refreshMaterializedView("v").build())).toThrow(
        UnsupportedDialectFeatureError,
      )
    }
  })
})

describe("DROP VIEW — cross-dialect", () => {
  for (const [label, dialect, openQ, closeQ] of [
    ["pg", pgDialect, '"', '"'],
    ["mysql", mysqlDialect, "`", "`"],
    ["sqlite", sqliteDialect, '"', '"'],
    ["mssql", mssqlDialect, "[", "]"],
  ] as const) {
    it(`${label} emits DROP VIEW`, () => {
      const db = sumak({ dialect: dialect(), tables: {} })
      const q = db.compileDDL(db.schema.dropView("v").build())
      expect(q.sql).toBe(`DROP VIEW ${openQ}v${closeQ}`)
    })
  }

  it("PG / MySQL / SQLite emit DROP VIEW IF EXISTS", () => {
    for (const dialect of [pgDialect, mysqlDialect, sqliteDialect] as const) {
      const db = sumak({ dialect: dialect(), tables: {} })
      const q = db.compileDDL(db.schema.dropView("v").ifExists().build())
      expect(q.sql).toContain("IF EXISTS")
    }
  })

  it("PG emits DROP MATERIALIZED VIEW", () => {
    const db = sumak({ dialect: pgDialect(), tables: {} })
    const q = db.compileDDL(db.schema.dropView("v").materialized().build())
    expect(q.sql).toContain("DROP MATERIALIZED VIEW")
  })
})

describe("CREATE VIEW — embedded SELECT preserves params", () => {
  it("WHERE clause params flow through to the outer compiled query", () => {
    const db = sumak({ dialect: pgDialect(), tables: schema })
    const sel = db
      .selectFrom("users")
      .where(({ active }) => active.eq(1))
      .select("id", "name")
      .build()
    const q = db.compileDDL(db.schema.createView("active_users").asSelect(sel).build())
    // The embedded SELECT's param placeholders must land in the
    // outer query's params — otherwise the driver gets `$1` in the
    // SQL with no bound value.
    expect(q.params).toEqual([1])
    expect(q.sql).toContain("$1")
    expect(q.sql).toContain('"active"')
  })
})

describe("PGlite roundtrip — create + select from + refresh", () => {
  let pg: PGlite

  beforeAll(async () => {
    pg = new PGlite()
    await pg.exec(`
      DROP TABLE IF EXISTS view_users CASCADE;
      CREATE TABLE view_users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        active INTEGER NOT NULL
      );
      INSERT INTO view_users (name, active) VALUES
        ('alice', 1), ('bob', 0), ('carol', 1);
    `)
  })

  afterAll(async () => {
    await pg?.close()
  })

  it("creates a regular VIEW and selects from it", async () => {
    const db = sumak({
      dialect: pgDialect(),
      driver: pgliteDriver(pg),
      tables: {
        view_users: {
          id: serial().primaryKey(),
          name: text().notNull(),
          active: integer().notNull(),
        },
      },
    })
    // PostgreSQL does NOT accept bound parameters in DDL statements,
    // so the view body must be self-contained. Use `unsafeRawExpr` for
    // the predicate so the value is inlined as a SQL literal rather
    // than bound. This mirrors what migration files do — never
    // parametrize DDL.
    const sel = db
      .selectFrom("view_users")
      .where(() => unsafeRawExpr<boolean>("active = 1"))
      .select("id", "name")
      .build()
    const createSql = db.compileDDL(db.schema.createView("v_active_users").asSelect(sel).build())
    await db.executeCompiledNoRows(createSql)
    const rows = await pg.query<{ id: number; name: string }>(
      `SELECT id, name FROM v_active_users ORDER BY id`,
    )
    expect(rows.rows.map((r) => r.name)).toEqual(["alice", "carol"])
    // Idempotent re-create via OR REPLACE — should not throw.
    const recreateSql = db.compileDDL(
      db.schema.createView("v_active_users").orReplace().asSelect(sel).build(),
    )
    await db.executeCompiledNoRows(recreateSql)
  })

  it("creates a MATERIALIZED VIEW, refreshes it, and selects from it", async () => {
    const db = sumak({
      dialect: pgDialect(),
      driver: pgliteDriver(pg),
      tables: {
        view_users: {
          id: serial().primaryKey(),
          name: text().notNull(),
          active: integer().notNull(),
        },
      },
    })
    const sel = db.selectFrom("view_users").select("id", "name", "active").build()
    const createSql = db.compileDDL(
      db.schema.createView("mv_users").materialized().asSelect(sel).build(),
    )
    await db.executeCompiledNoRows(createSql)
    // Insert one more row and refresh — the view's cached rows should
    // not include the new row until REFRESH runs.
    await pg.exec(`INSERT INTO view_users (name, active) VALUES ('dave', 1)`)
    const beforeRefresh = await pg.query<{ count: number }>(`SELECT COUNT(*)::int FROM mv_users`)
    expect(beforeRefresh.rows[0]!.count).toBe(3)
    const refreshSql = db.compileDDL(db.schema.refreshMaterializedView("mv_users").build())
    await db.executeCompiledNoRows(refreshSql)
    const afterRefresh = await pg.query<{ count: number }>(`SELECT COUNT(*)::int FROM mv_users`)
    expect(afterRefresh.rows[0]!.count).toBe(4)
    // Clean up.
    await db.executeCompiledNoRows(
      db.compileDDL(db.schema.dropView("mv_users").materialized().build()),
    )
  })
})
