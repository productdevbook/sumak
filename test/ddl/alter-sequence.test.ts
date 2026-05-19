import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "../integration/pglite-driver.ts"

describe("ALTER SEQUENCE — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables: {} })

  it("RESTART (bare)", () => {
    const q = db.compileDDL(db.schema.alterSequence("order_no").restart().build())
    expect(q.sql).toBe('ALTER SEQUENCE "order_no" RESTART')
  })

  it("RESTART WITH n", () => {
    const q = db.compileDDL(db.schema.alterSequence("order_no").restartWith(1000).build())
    expect(q.sql).toBe('ALTER SEQUENCE "order_no" RESTART WITH 1000')
  })

  it("INCREMENT BY", () => {
    const q = db.compileDDL(db.schema.alterSequence("counter").increment(5).build())
    expect(q.sql).toBe('ALTER SEQUENCE "counter" INCREMENT BY 5')
  })

  it("negative increment", () => {
    const q = db.compileDDL(db.schema.alterSequence("counter").increment(-1).build())
    expect(q.sql).toBe('ALTER SEQUENCE "counter" INCREMENT BY -1')
  })

  it("IF EXISTS", () => {
    const q = db.compileDDL(db.schema.alterSequence("s").ifExists().restartWith(1).build())
    expect(q.sql).toBe('ALTER SEQUENCE IF EXISTS "s" RESTART WITH 1')
  })

  it("AS <type>", () => {
    const q = db.compileDDL(db.schema.alterSequence("s").dataType("bigint").build())
    expect(q.sql).toBe('ALTER SEQUENCE "s" AS bigint')
  })

  it("MINVALUE / MAXVALUE / NO MINVALUE / NO MAXVALUE", () => {
    const q1 = db.compileDDL(db.schema.alterSequence("s").minValue(10).maxValue(1000).build())
    expect(q1.sql).toBe('ALTER SEQUENCE "s" MINVALUE 10 MAXVALUE 1000')

    const q2 = db.compileDDL(db.schema.alterSequence("s").noMinValue().noMaxValue().build())
    expect(q2.sql).toBe('ALTER SEQUENCE "s" NO MINVALUE NO MAXVALUE')
  })

  it("START WITH (PG only)", () => {
    const q = db.compileDDL(db.schema.alterSequence("s").start(100).build())
    expect(q.sql).toBe('ALTER SEQUENCE "s" START WITH 100')
  })

  it("CACHE", () => {
    const q = db.compileDDL(db.schema.alterSequence("s").cache(50).build())
    expect(q.sql).toBe('ALTER SEQUENCE "s" CACHE 50')
  })

  it("CYCLE / NO CYCLE", () => {
    const q1 = db.compileDDL(db.schema.alterSequence("s").cycle().build())
    expect(q1.sql).toBe('ALTER SEQUENCE "s" CYCLE')

    const q2 = db.compileDDL(db.schema.alterSequence("s").noCycle().build())
    expect(q2.sql).toBe('ALTER SEQUENCE "s" NO CYCLE')
  })

  it("OWNED BY t.c", () => {
    const q = db.compileDDL(db.schema.alterSequence("s").ownedBy("orders", "id").build())
    expect(q.sql).toBe('ALTER SEQUENCE "s" OWNED BY "orders"."id"')
  })

  it("OWNED BY NONE", () => {
    const q = db.compileDDL(db.schema.alterSequence("s").ownedByNone().build())
    expect(q.sql).toBe('ALTER SEQUENCE "s" OWNED BY NONE')
  })

  it("schema-qualified name", () => {
    const q = db.compileDDL(db.schema.alterSequence("seq", "audit").restartWith(1).build())
    expect(q.sql).toBe('ALTER SEQUENCE "audit"."seq" RESTART WITH 1')
  })

  it("all options together", () => {
    const q = db.compileDDL(
      db.schema
        .alterSequence("order_no")
        .dataType("bigint")
        .increment(2)
        .minValue(100)
        .maxValue(10_000)
        .start(1000)
        .restartWith(500)
        .cache(50)
        .cycle()
        .ownedBy("orders", "id")
        .build(),
    )
    expect(q.sql).toBe(
      'ALTER SEQUENCE "order_no" AS bigint INCREMENT BY 2 MINVALUE 100 MAXVALUE 10000 START WITH 1000 RESTART WITH 500 CACHE 50 CYCLE OWNED BY "orders"."id"',
    )
  })

  it("rejects bare ALTER SEQUENCE with no options", () => {
    expect(() => db.compileDDL(db.schema.alterSequence("s").build())).toThrow(
      /requires at least one option/,
    )
  })

  it("rejects non-integer increment", () => {
    expect(() => db.compileDDL(db.schema.alterSequence("s").increment(1.5).build())).toThrow(
      /increment must be a finite integer/,
    )
  })

  it("rejects non-integer restart target", () => {
    expect(() => db.compileDDL(db.schema.alterSequence("s").restartWith(3.14).build())).toThrow(
      /restart must be a finite integer/,
    )
  })

  it("rejects an invalid AS dataType", () => {
    expect(() =>
      db.compileDDL(db.schema.alterSequence("s").dataType("bigint; DROP TABLE").build()),
    ).toThrow()
  })

  it("refuses NO CACHE on PG (MSSQL-only keyword)", () => {
    expect(() => db.compileDDL(db.schema.alterSequence("s").noCache().build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })
})

describe("ALTER SEQUENCE — MSSQL divergence", () => {
  const db = sumak({ dialect: mssqlDialect(), tables: {} })

  it("basic RESTART works", () => {
    const q = db.compileDDL(db.schema.alterSequence("s").restartWith(1).build())
    expect(q.sql).toBe("ALTER SEQUENCE [s] RESTART WITH 1")
  })

  it("emits INCREMENT / MIN / MAX / CACHE / CYCLE", () => {
    const q = db.compileDDL(
      db.schema
        .alterSequence("s")
        .increment(1)
        .minValue(0)
        .maxValue(1_000_000)
        .cache(100)
        .cycle()
        .build(),
    )
    expect(q.sql).toBe(
      "ALTER SEQUENCE [s] INCREMENT BY 1 MINVALUE 0 MAXVALUE 1000000 CACHE 100 CYCLE",
    )
  })

  it("NO CACHE is MSSQL-only", () => {
    const q = db.compileDDL(db.schema.alterSequence("s").noCache().build())
    expect(q.sql).toBe("ALTER SEQUENCE [s] NO CACHE")
  })

  it("refuses IF EXISTS with the wrapper hint", () => {
    expect(() => db.compileDDL(db.schema.alterSequence("s").ifExists().restart().build())).toThrow(
      /IF EXISTS/,
    )
  })

  it("refuses AS <type>", () => {
    expect(() => db.compileDDL(db.schema.alterSequence("s").dataType("bigint").build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })

  it("refuses START WITH", () => {
    expect(() => db.compileDDL(db.schema.alterSequence("s").start(100).build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })

  it("refuses OWNED BY", () => {
    expect(() => db.compileDDL(db.schema.alterSequence("s").ownedBy("t", "c").build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })

  it("refuses OWNED BY NONE", () => {
    expect(() => db.compileDDL(db.schema.alterSequence("s").ownedByNone().build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })
})

describe("ALTER SEQUENCE — MySQL / SQLite refusal", () => {
  it("MySQL refuses ALTER SEQUENCE", () => {
    const db = sumak({ dialect: mysqlDialect(), tables: {} })
    expect(() => db.compileDDL(db.schema.alterSequence("s").restartWith(1).build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })

  it("SQLite refuses ALTER SEQUENCE", () => {
    const db = sumak({ dialect: sqliteDialect(), tables: {} })
    expect(() => db.compileDDL(db.schema.alterSequence("s").restartWith(1).build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })
})

describe("ALTER SEQUENCE — PGlite roundtrip", () => {
  let pg: PGlite

  beforeAll(async () => {
    pg = new PGlite()
  })

  afterAll(async () => {
    await pg?.close()
  })

  it("RESTART WITH n moves the next nextval to n", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: {} })

    // Create the sequence starting at 1.
    await db.executeCompiledNoRows(
      db.compileDDL(db.schema.createSequence("alter_test_seq").start(1).build()),
    )

    // Advance it a few times.
    const r1 = await pg.query<{ v: number }>(`SELECT nextval('alter_test_seq') AS v`)
    expect(Number(r1.rows[0]!.v)).toBe(1)
    const r2 = await pg.query<{ v: number }>(`SELECT nextval('alter_test_seq') AS v`)
    expect(Number(r2.rows[0]!.v)).toBe(2)

    // Now ALTER SEQUENCE ... RESTART WITH 100 — the next nextval
    // should pick up that new starting point.
    await db.executeCompiledNoRows(
      db.compileDDL(db.schema.alterSequence("alter_test_seq").restartWith(100).build()),
    )
    const r3 = await pg.query<{ v: number }>(`SELECT nextval('alter_test_seq') AS v`)
    expect(Number(r3.rows[0]!.v)).toBe(100)
    const r4 = await pg.query<{ v: number }>(`SELECT nextval('alter_test_seq') AS v`)
    expect(Number(r4.rows[0]!.v)).toBe(101)

    // Drop.
    await db.executeCompiledNoRows(db.compileDDL(db.schema.dropSequence("alter_test_seq").build()))
  })

  it("INCREMENT BY change takes effect on the next nextval", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: {} })

    await db.executeCompiledNoRows(
      db.compileDDL(db.schema.createSequence("alter_inc_seq").start(1).increment(1).build()),
    )

    // First call → 1.
    const r1 = await pg.query<{ v: number }>(`SELECT nextval('alter_inc_seq') AS v`)
    expect(Number(r1.rows[0]!.v)).toBe(1)

    // Change the step to 10.
    await db.executeCompiledNoRows(
      db.compileDDL(db.schema.alterSequence("alter_inc_seq").increment(10).build()),
    )

    // Next call → 11 (1 + 10).
    const r2 = await pg.query<{ v: number }>(`SELECT nextval('alter_inc_seq') AS v`)
    expect(Number(r2.rows[0]!.v)).toBe(11)
    const r3 = await pg.query<{ v: number }>(`SELECT nextval('alter_inc_seq') AS v`)
    expect(Number(r3.rows[0]!.v)).toBe(21)

    // Drop.
    await db.executeCompiledNoRows(db.compileDDL(db.schema.dropSequence("alter_inc_seq").build()))
  })

  it("ALTER SEQUENCE IF EXISTS does not throw when the sequence is missing", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: {} })

    // Sequence does not exist — IF EXISTS is the difference between
    // "no-op" and "error".
    await db.executeCompiledNoRows(
      db.compileDDL(db.schema.alterSequence("never_existed_seq").ifExists().restartWith(1).build()),
    )
  })
})
