import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { currval, nextval, setval } from "../../src/builder/eb.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { InvalidExpressionError, UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "../integration/pglite-driver.ts"

describe("CREATE SEQUENCE — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables: {} })

  it("basic CREATE SEQUENCE", () => {
    const q = db.compileDDL(db.schema.createSequence("order_no").build())
    expect(q.sql).toBe('CREATE SEQUENCE "order_no"')
  })

  it("CREATE SEQUENCE IF NOT EXISTS", () => {
    const q = db.compileDDL(db.schema.createSequence("order_no").ifNotExists().build())
    expect(q.sql).toBe('CREATE SEQUENCE IF NOT EXISTS "order_no"')
  })

  it("with all options", () => {
    const q = db.compileDDL(
      db.schema
        .createSequence("order_no")
        .dataType("bigint")
        .increment(2)
        .minValue(100)
        .maxValue(10_000)
        .start(1000)
        .cache(50)
        .cycle()
        .build(),
    )
    expect(q.sql).toBe(
      'CREATE SEQUENCE "order_no" AS bigint INCREMENT BY 2 MINVALUE 100 MAXVALUE 10000 START WITH 1000 CACHE 50 CYCLE',
    )
  })

  it("NO MINVALUE / NO MAXVALUE / NO CYCLE", () => {
    const q = db.compileDDL(
      db.schema.createSequence("counter").noMinValue().noMaxValue().noCycle().build(),
    )
    expect(q.sql).toBe('CREATE SEQUENCE "counter" NO MINVALUE NO MAXVALUE NO CYCLE')
  })

  it("negative increment for descending sequence", () => {
    const q = db.compileDDL(db.schema.createSequence("countdown").increment(-1).start(100).build())
    expect(q.sql).toBe('CREATE SEQUENCE "countdown" INCREMENT BY -1 START WITH 100')
  })

  it("OWNED BY <table>.<column>", () => {
    const q = db.compileDDL(db.schema.createSequence("order_no").ownedBy("orders", "id").build())
    expect(q.sql).toBe('CREATE SEQUENCE "order_no" OWNED BY "orders"."id"')
  })

  it("OWNED BY NONE clears ownership", () => {
    const q = db.compileDDL(db.schema.createSequence("order_no").ownedByNone().build())
    expect(q.sql).toBe('CREATE SEQUENCE "order_no" OWNED BY NONE')
  })

  it("schema-qualified name", () => {
    const q = db.compileDDL(db.schema.createSequence("seq", "audit").build())
    expect(q.sql).toBe('CREATE SEQUENCE "audit"."seq"')
  })

  it("rejects non-integer increment", () => {
    expect(() => db.compileDDL(db.schema.createSequence("s").increment(1.5).build())).toThrow(
      /increment must be a finite integer/,
    )
  })

  it("rejects an invalid AS dataType", () => {
    // The data-type validator catches `bigint; DROP TABLE` and other
    // smuggled DDL via the unquoted-type slot.
    expect(() =>
      db.compileDDL(db.schema.createSequence("s").dataType("bigint; DROP TABLE").build()),
    ).toThrow()
  })
})

describe("CREATE SEQUENCE — MSSQL divergence", () => {
  const db = sumak({ dialect: mssqlDialect(), tables: {} })

  it("basic CREATE SEQUENCE works", () => {
    const q = db.compileDDL(db.schema.createSequence("order_no").build())
    expect(q.sql).toBe("CREATE SEQUENCE [order_no]")
  })

  it("emits CACHE / CYCLE / START / INCREMENT", () => {
    const q = db.compileDDL(
      db.schema
        .createSequence("order_no")
        .dataType("bigint")
        .start(1)
        .increment(1)
        .cache(20)
        .cycle()
        .build(),
    )
    expect(q.sql).toBe(
      "CREATE SEQUENCE [order_no] AS bigint INCREMENT BY 1 START WITH 1 CACHE 20 CYCLE",
    )
  })

  it("refuses IF NOT EXISTS with the wrapper hint", () => {
    expect(() => db.compileDDL(db.schema.createSequence("s").ifNotExists().build())).toThrow(
      /IF NOT EXISTS/,
    )
  })

  it("refuses OWNED BY", () => {
    expect(() => db.compileDDL(db.schema.createSequence("s").ownedBy("t", "c").build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })

  it("refuses OWNED BY NONE", () => {
    expect(() => db.compileDDL(db.schema.createSequence("s").ownedByNone().build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })
})

describe("CREATE SEQUENCE — MySQL / SQLite refusal", () => {
  it("MySQL refuses CREATE SEQUENCE", () => {
    const db = sumak({ dialect: mysqlDialect(), tables: {} })
    expect(() => db.compileDDL(db.schema.createSequence("s").build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })

  it("SQLite refuses CREATE SEQUENCE", () => {
    const db = sumak({ dialect: sqliteDialect(), tables: {} })
    expect(() => db.compileDDL(db.schema.createSequence("s").build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })
})

describe("DROP SEQUENCE — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables: {} })

  it("basic DROP SEQUENCE", () => {
    const q = db.compileDDL(db.schema.dropSequence("order_no").build())
    expect(q.sql).toBe('DROP SEQUENCE "order_no"')
  })

  it("DROP SEQUENCE IF EXISTS", () => {
    const q = db.compileDDL(db.schema.dropSequence("order_no").ifExists().build())
    expect(q.sql).toBe('DROP SEQUENCE IF EXISTS "order_no"')
  })

  it("DROP SEQUENCE ... CASCADE", () => {
    const q = db.compileDDL(db.schema.dropSequence("order_no").ifExists().cascade().build())
    expect(q.sql).toBe('DROP SEQUENCE IF EXISTS "order_no" CASCADE')
  })

  it("schema-qualified name", () => {
    const q = db.compileDDL(db.schema.dropSequence("seq", "audit").build())
    expect(q.sql).toBe('DROP SEQUENCE "audit"."seq"')
  })
})

describe("DROP SEQUENCE — MSSQL", () => {
  const db = sumak({ dialect: mssqlDialect(), tables: {} })

  it("basic DROP SEQUENCE", () => {
    const q = db.compileDDL(db.schema.dropSequence("order_no").build())
    expect(q.sql).toBe("DROP SEQUENCE [order_no]")
  })

  it("IF EXISTS works", () => {
    const q = db.compileDDL(db.schema.dropSequence("s").ifExists().build())
    expect(q.sql).toBe("DROP SEQUENCE IF EXISTS [s]")
  })

  it("refuses CASCADE", () => {
    expect(() => db.compileDDL(db.schema.dropSequence("s").cascade().build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })
})

describe("DROP SEQUENCE — MySQL / SQLite refusal", () => {
  it("MySQL refuses DROP SEQUENCE", () => {
    const db = sumak({ dialect: mysqlDialect(), tables: {} })
    expect(() => db.compileDDL(db.schema.dropSequence("s").build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })

  it("SQLite refuses DROP SEQUENCE", () => {
    const db = sumak({ dialect: sqliteDialect(), tables: {} })
    expect(() => db.compileDDL(db.schema.dropSequence("s").build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })
})

describe("nextval / currval / setval — PG only", () => {
  it("nextval emits the standard form", () => {
    const db = sumak({ dialect: pgDialect(), tables: {} })
    const q = db
      .selectFrom("dummy" as never)
      .select({ v: nextval("order_no_seq") })
      .build()
    const compiled = db.compile(q)
    expect(compiled.sql).toContain("NEXTVAL('order_no_seq')")
  })

  it("currval emits the standard form", () => {
    const db = sumak({ dialect: pgDialect(), tables: {} })
    const q = db
      .selectFrom("dummy" as never)
      .select({ v: currval("order_no_seq") })
      .build()
    const compiled = db.compile(q)
    expect(compiled.sql).toContain("CURRVAL('order_no_seq')")
  })

  it("setval(seq, n) emits two args", () => {
    const db = sumak({ dialect: pgDialect(), tables: {} })
    const q = db
      .selectFrom("dummy" as never)
      .select({ v: setval("order_no_seq", 1000) })
      .build()
    const compiled = db.compile(q)
    expect(compiled.sql).toContain("SETVAL('order_no_seq', 1000)")
  })

  it("setval(seq, n, is_called) emits three args", () => {
    const db = sumak({ dialect: pgDialect(), tables: {} })
    const q = db
      .selectFrom("dummy" as never)
      .select({ v: setval("order_no_seq", 1000, false) })
      .build()
    const compiled = db.compile(q)
    expect(compiled.sql).toContain("SETVAL('order_no_seq', 1000, FALSE)")
  })

  it("rejects non-integer setval value", () => {
    expect(() => setval("s", 1.5)).toThrow(InvalidExpressionError)
    expect(() => setval("s", Number.POSITIVE_INFINITY)).toThrow(InvalidExpressionError)
  })

  it("rejects exotic sequence names", () => {
    expect(() => nextval("foo; DROP TABLE bar")).toThrow(InvalidExpressionError)
    expect(() => currval("foo'")).toThrow(InvalidExpressionError)
    expect(() => setval("a.b.c", 1)).toThrow(InvalidExpressionError)
  })

  it("accepts schema-qualified names", () => {
    const db = sumak({ dialect: pgDialect(), tables: {} })
    const q = db
      .selectFrom("dummy" as never)
      .select({ v: nextval("audit.seq") })
      .build()
    const compiled = db.compile(q)
    expect(compiled.sql).toContain("NEXTVAL('audit.seq')")
  })

  for (const [label, dialect] of [
    ["mysql", mysqlDialect],
    ["sqlite", sqliteDialect],
    ["mssql", mssqlDialect],
  ] as const) {
    it(`${label} refuses nextval / currval / setval at print`, () => {
      const db = sumak({ dialect: dialect(), tables: {} })
      const q1 = db
        .selectFrom("dummy" as never)
        .select({ v: nextval("s") })
        .build()
      const q2 = db
        .selectFrom("dummy" as never)
        .select({ v: currval("s") })
        .build()
      const q3 = db
        .selectFrom("dummy" as never)
        .select({ v: setval("s", 1) })
        .build()
      expect(() => db.compile(q1)).toThrow(UnsupportedDialectFeatureError)
      expect(() => db.compile(q2)).toThrow(UnsupportedDialectFeatureError)
      expect(() => db.compile(q3)).toThrow(UnsupportedDialectFeatureError)
    })
  }
})

describe("PGlite roundtrip — create sequence, call nextval, verify values", () => {
  let pg: PGlite

  beforeAll(async () => {
    pg = new PGlite()
  })

  afterAll(async () => {
    await pg?.close()
  })

  it("creates a sequence, advances it, and observes the values", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: {} })

    // Create the sequence with explicit START 100, INCREMENT 1.
    const createSql = db.compileDDL(
      db.schema.createSequence("test_seq").start(100).increment(1).build(),
    )
    await db.executeCompiledNoRows(createSql)

    // First nextval — should return the start value (100).
    const r1 = await pg.query<{ v: number }>(`SELECT nextval('test_seq') AS v`)
    expect(Number(r1.rows[0]!.v)).toBe(100)

    // Second nextval — should advance by 1.
    const r2 = await pg.query<{ v: number }>(`SELECT nextval('test_seq') AS v`)
    expect(Number(r2.rows[0]!.v)).toBe(101)

    // currval — should match the last nextval.
    const r3 = await pg.query<{ v: number }>(`SELECT currval('test_seq') AS v`)
    expect(Number(r3.rows[0]!.v)).toBe(101)

    // setval — reset and observe.
    await pg.query(`SELECT setval('test_seq', 500, true)`)
    const r4 = await pg.query<{ v: number }>(`SELECT nextval('test_seq') AS v`)
    expect(Number(r4.rows[0]!.v)).toBe(501)

    // Drop the sequence to leave the database clean.
    await db.executeCompiledNoRows(db.compileDDL(db.schema.dropSequence("test_seq").build()))
  })

  it("nextval emitted via the builder runs against PGlite", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: {} })

    // Create the sequence fresh.
    await db.executeCompiledNoRows(
      db.compileDDL(db.schema.createSequence("builder_seq").start(1).build()),
    )

    // Build a SELECT through the builder using `nextval(...)`.
    const selectNode = db
      .selectFrom("nope" as never)
      .select({ v: nextval("builder_seq") })
      .build()
    // The selectFrom("nope") path appends a `FROM` clause we don't want
    // for a SELECT-only-expression query; compile and rewrite to drop
    // the FROM table. Easier: roundtrip a raw query that uses the same
    // emitted SQL fragment, and verify the value increments.
    const compiled = db.compile(selectNode)
    // The compiled SQL contains `NEXTVAL('builder_seq')`. Strip the
    // bogus `FROM "nope"` so PGlite can execute it.
    const sql = compiled.sql.replace(/FROM "nope"/, "")
    const r = await pg.query<{ v: number }>(sql, [...compiled.params])
    expect(Number(r.rows[0]!.v)).toBe(1)

    // Drop.
    await db.executeCompiledNoRows(db.compileDDL(db.schema.dropSequence("builder_seq").build()))
  })

  it("CREATE SEQUENCE IF NOT EXISTS is idempotent", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: {} })

    const createSql = db.compileDDL(db.schema.createSequence("idempo_seq").ifNotExists().build())
    await db.executeCompiledNoRows(createSql)
    // Re-create — must not throw.
    await db.executeCompiledNoRows(createSql)

    // Drop with IF EXISTS — must not throw even after the drop.
    const dropSql = db.compileDDL(db.schema.dropSequence("idempo_seq").ifExists().build())
    await db.executeCompiledNoRows(dropSql)
    await db.executeCompiledNoRows(dropSql)
  })
})
