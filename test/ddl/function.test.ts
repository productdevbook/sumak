import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { typedCol } from "../../src/ast/typed-expression.ts"
import { add, mul } from "../../src/builder/eb.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { arg, createFunction, dropFunction, sumak, val } from "../../src/index.ts"
import { pgliteDriver } from "../integration/pglite-driver.ts"

const pg = sumak({ dialect: pgDialect(), tables: {} })

describe("CREATE FUNCTION — builder shape", () => {
  it("returns a TypedFunction with a CreateFunctionNode and a .call() method", () => {
    const fn = createFunction("compute_taxes")
      .args({
        price: arg("numeric"),
        tax: arg("numeric", { default: val(0.2) }),
      })
      .returns("numeric")
      .languageSql()
      .body(({ price, tax }) => mul(price, add(val(1), tax)))
      .build()
    expect(fn.node.type).toBe("create_function")
    expect(fn.node.name).toBe("compute_taxes")
    expect(fn.node.language).toBe("sql")
    expect(fn.node.args).toHaveLength(2)
    expect(typeof fn.call).toBe("function")
  })

  it(".orReplace() sets the flag", () => {
    const fn = createFunction("f")
      .args({})
      .returns("integer")
      .languageSql()
      .body(() => val(1))
      .orReplace()
      .build()
    expect(fn.node.orReplace).toBe(true)
  })

  it("immutable / stable / strict / parallel / security flags carry through", () => {
    const fn = createFunction("f")
      .args({})
      .returns("integer")
      .languageSql()
      .immutable()
      .strict()
      .parallel("safe")
      .security("definer")
      .body(() => val(1))
      .build()
    expect(fn.node).toMatchObject({
      immutable: true,
      strict: true,
      parallel: "safe",
      security: "definer",
    })
  })

  it(".stable() and .immutable() are mutually exclusive (last wins)", () => {
    const fn = createFunction("f")
      .args({})
      .returns("integer")
      .languageSql()
      .immutable()
      .stable()
      .body(() => val(1))
      .build()
    expect(fn.node.stable).toBe(true)
    expect(fn.node.immutable).toBe(false)
  })

  it("body callback receives Expression<T> args keyed by the args map", () => {
    let captured: unknown = null
    createFunction("f")
      .args({ price: arg("numeric"), tax: arg("numeric") })
      .returns("numeric")
      .languageSql()
      .body((a) => {
        captured = a
        return mul(a.price, add(val(1), a.tax))
      })
      .build()
    expect(captured).not.toBeNull()
    expect((captured as { price: { node: unknown } }).price.node).toMatchObject({
      type: "column_ref",
      column: "price",
    })
  })

  it(".build() requires .returns() / .languageSql() / .body() before compiling", () => {
    expect(() => (createFunction("f") as { build: () => unknown }).build()).toThrow(/returns/)
  })
})

describe("CREATE FUNCTION — PG emission", () => {
  it("the compute_taxes example emits the documented shape", () => {
    const fn = createFunction("compute_taxes")
      .args({
        price: arg("numeric"),
        tax: arg("numeric", { default: val(0.2) }),
      })
      .returns("numeric")
      .languageSql()
      .body(({ price, tax }) => mul(price, add(val(1), tax)))
      .build()
    const q = pg.compileDDL(fn.node)
    expect(q.sql).toBe(
      `CREATE FUNCTION "compute_taxes"("price" numeric, "tax" numeric DEFAULT 0.2) RETURNS numeric LANGUAGE sql AS $$ SELECT ("price" * (1 + "tax")) $$`,
    )
  })

  it("LANGUAGE sql emits AS $$ SELECT <expr> $$", () => {
    const fn = createFunction("inc")
      .args({ x: arg("integer") })
      .returns("integer")
      .languageSql()
      .body(({ x }) => add(x, val(1)))
      .build()
    const q = pg.compileDDL(fn.node)
    expect(q.sql).toBe(
      `CREATE FUNCTION "inc"("x" integer) RETURNS integer LANGUAGE sql AS $$ SELECT ("x" + 1) $$`,
    )
  })

  it("LANGUAGE plpgsql emits AS $$ BEGIN RETURN <expr>; END $$", () => {
    const fn = createFunction("inc")
      .args({ x: arg("integer") })
      .returns("integer")
      .languagePlpgsql()
      .body(({ x }) => add(x, val(1)))
      .build()
    const q = pg.compileDDL(fn.node)
    expect(q.sql).toBe(
      `CREATE FUNCTION "inc"("x" integer) RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN ("x" + 1); END $$`,
    )
  })

  it("OR REPLACE emits CREATE OR REPLACE FUNCTION", () => {
    const fn = createFunction("inc")
      .args({ x: arg("integer") })
      .returns("integer")
      .languageSql()
      .orReplace()
      .body(({ x }) => add(x, val(1)))
      .build()
    const q = pg.compileDDL(fn.node)
    expect(q.sql.startsWith('CREATE OR REPLACE FUNCTION "inc"(')).toBe(true)
  })

  it("args with DEFAULT round-trip", () => {
    const fn = createFunction("greet")
      .args({ name: arg("text", { default: val("world") }) })
      .returns("text")
      .languageSql()
      .body(({ name }) => name)
      .build()
    const q = pg.compileDDL(fn.node)
    expect(q.sql).toBe(
      `CREATE FUNCTION "greet"("name" text DEFAULT 'world') RETURNS text LANGUAGE sql AS $$ SELECT "name" $$`,
    )
  })

  it("IMMUTABLE / STABLE / STRICT / PARALLEL / SECURITY clauses", () => {
    const fn = createFunction("calc")
      .args({ x: arg("integer") })
      .returns("integer")
      .languageSql()
      .immutable()
      .strict()
      .parallel("safe")
      .security("definer")
      .body(({ x }) => x)
      .build()
    const q = pg.compileDDL(fn.node)
    expect(q.sql).toBe(
      `CREATE FUNCTION "calc"("x" integer) RETURNS integer LANGUAGE sql IMMUTABLE STRICT PARALLEL safe SECURITY DEFINER AS $$ SELECT "x" $$`,
    )
  })

  it("STABLE emits STABLE (separate from IMMUTABLE)", () => {
    const fn = createFunction("calc")
      .args({})
      .returns("integer")
      .languageSql()
      .stable()
      .body(() => val(1))
      .build()
    const q = pg.compileDDL(fn.node)
    expect(q.sql).toContain("STABLE")
    expect(q.sql).not.toContain("IMMUTABLE")
  })

  it("argument mode emits the keyword (OUT / INOUT / VARIADIC)", () => {
    const fn = createFunction("ret")
      .args({
        a: arg("integer"),
        out_b: arg("integer", { mode: "OUT" }),
      })
      .returns("integer")
      .languageSql()
      .body(({ a }) => a)
      .build()
    const q = pg.compileDDL(fn.node)
    expect(q.sql).toContain(`"a" integer, OUT "out_b" integer`)
  })

  it("via db.schema.createFunction()", () => {
    const fn = pg.schema
      .createFunction("inc")
      .args({ x: arg("integer") })
      .returns("integer")
      .languageSql()
      .body(({ x }) => add(x, val(1)))
      .build()
    const q = pg.compileDDL(fn.node)
    expect(q.sql).toContain('CREATE FUNCTION "inc"')
  })

  it("rejects IMMUTABLE + STABLE on a hand-rolled AST", () => {
    const bad = {
      type: "create_function",
      name: "f",
      args: [],
      returns: "integer",
      language: "sql",
      body: { type: "literal", value: 1 },
      immutable: true,
      stable: true,
    } as unknown as Parameters<typeof pg.compileDDL>[0]
    expect(() => pg.compileDDL(bad)).toThrow(/mutually exclusive/)
  })

  it("rejects an unknown language on a hand-rolled AST", () => {
    const bad = {
      type: "create_function",
      name: "f",
      args: [],
      returns: "integer",
      language: "pl/python",
      body: { type: "literal", value: 1 },
    } as unknown as Parameters<typeof pg.compileDDL>[0]
    expect(() => pg.compileDDL(bad)).toThrow(/language must be/)
  })

  it("rejects an empty arg name on a hand-rolled AST", () => {
    const bad = {
      type: "create_function",
      name: "f",
      args: [{ name: "", type: "integer" }],
      returns: "integer",
      language: "sql",
      body: { type: "literal", value: 1 },
    } as unknown as Parameters<typeof pg.compileDDL>[0]
    expect(() => pg.compileDDL(bad)).toThrow(/argument needs a name/)
  })
})

describe("CREATE FUNCTION — call-site type inference", () => {
  it("produces a function_call Expression that round-trips through SELECT", () => {
    const taxes = createFunction("compute_taxes")
      .args({
        price: arg("numeric"),
        tax: arg("numeric"),
      })
      .returns("numeric")
      .languageSql()
      .body(({ price, tax }) => mul(price, add(val(1), tax)))
      .build()
    const call = taxes.call({ price: typedCol<number>("price"), tax: val(0.18) })
    expect(call.node).toMatchObject({
      type: "function_call",
      name: "compute_taxes",
    })
    expect(call.node.type === "function_call" && call.node.args).toHaveLength(2)
  })

  it("the call accepts a raw primitive in place of Expression", () => {
    const inc = createFunction("inc")
      .args({ x: arg("integer") })
      .returns("integer")
      .languageSql()
      .body(({ x }) => add(x, val(1)))
      .build()
    const call = inc.call({ x: 5 })
    expect(call.node).toMatchObject({
      type: "function_call",
      name: "inc",
    })
  })

  it("cross-function call — function A's body calls function B", () => {
    const inc = createFunction("inc")
      .args({ x: arg("integer") })
      .returns("integer")
      .languageSql()
      .body(({ x }) => add(x, val(1)))
      .build()
    const inc2 = createFunction("inc2")
      .args({ x: arg("integer") })
      .returns("integer")
      .languageSql()
      .body(({ x }) => inc.call({ x: inc.call({ x }) }))
      .build()
    const q = pg.compileDDL(inc2.node)
    expect(q.sql).toBe(
      `CREATE FUNCTION "inc2"("x" integer) RETURNS integer LANGUAGE sql AS $$ SELECT inc(inc("x")) $$`,
    )
  })
})

describe("DROP FUNCTION — builder shape", () => {
  it("dropFunction(name) — bare form", () => {
    const n = dropFunction("inc").build()
    expect(n).toMatchObject({ type: "drop_function", name: "inc" })
  })

  it(".argTypes(...) carries the list", () => {
    const n = dropFunction("inc").argTypes("integer", "text").build()
    expect(n.argTypes).toEqual(["integer", "text"])
  })

  it(".ifExists() and .cascade() flags", () => {
    const n = dropFunction("inc").ifExists().cascade().build()
    expect(n).toMatchObject({ ifExists: true, cascade: true })
  })

  it("builder.build() returns an independent argTypes copy", () => {
    const b = dropFunction("inc").argTypes("integer")
    const n = b.build()
    n.argTypes!.push("text")
    const fresh = b.build()
    expect(fresh.argTypes).toEqual(["integer"])
  })
})

describe("DROP FUNCTION — PG emission", () => {
  it("bare drop", () => {
    const q = pg.compileDDL(dropFunction("inc").build())
    expect(q.sql).toBe(`DROP FUNCTION "inc"`)
  })

  it("with argTypes", () => {
    const q = pg.compileDDL(dropFunction("inc").argTypes("integer").build())
    expect(q.sql).toBe(`DROP FUNCTION "inc"(integer)`)
  })

  it("with IF EXISTS and CASCADE", () => {
    const q = pg.compileDDL(dropFunction("inc").argTypes("integer").ifExists().cascade().build())
    expect(q.sql).toBe(`DROP FUNCTION IF EXISTS "inc"(integer) CASCADE`)
  })

  it("via db.schema.dropFunction()", () => {
    const q = pg.compileDDL(pg.schema.dropFunction("inc").ifExists().build())
    expect(q.sql).toBe(`DROP FUNCTION IF EXISTS "inc"`)
  })
})

describe("non-PG dialects refuse every function surface", () => {
  const dialects = [
    ["MySQL", mysqlDialect()],
    ["SQLite", sqliteDialect()],
    ["MSSQL", mssqlDialect()],
  ] as const

  for (const [label, dialect] of dialects) {
    describe(label, () => {
      const db = sumak({ dialect, tables: {} })

      it("CREATE FUNCTION refuses", () => {
        const fn = createFunction("inc")
          .args({ x: arg("integer") })
          .returns("integer")
          .languageSql()
          .body(({ x }) => x)
          .build()
        expect(() => db.compileDDL(fn.node)).toThrow(UnsupportedDialectFeatureError)
      })

      it("DROP FUNCTION refuses", () => {
        expect(() => db.compileDDL(dropFunction("inc").build())).toThrow(
          UnsupportedDialectFeatureError,
        )
      })
    })
  }
})

describe("CREATE FUNCTION — PGlite roundtrip", () => {
  let pglite: PGlite

  beforeAll(async () => {
    pglite = new PGlite()
    await pglite.waitReady
  })

  afterAll(async () => {
    await pglite.close()
  })

  it("creates a function, calls it from SELECT, returns the typed result", async () => {
    const driver = pgliteDriver(pglite)
    const taxes = createFunction("compute_taxes_rt")
      .args({
        price: arg("numeric"),
        tax: arg("numeric"),
      })
      .returns("numeric")
      .languageSql()
      .body(({ price, tax }) => mul(price, add(val(1), tax)))
      .build()

    const createSql = pg.compileDDL(taxes.node)
    await driver.execute(createSql.sql, createSql.params)

    // Verify call via plain SQL — taxes.call() builds the AST node, but
    // the integration test focuses on the emitted DDL working end-to-end.
    const r = await driver.query(`SELECT compute_taxes_rt(100, 0.18) AS result`, [])
    expect(Number((r[0] as { result: number | string }).result)).toBeCloseTo(118, 6)

    // Clean up so other tests on the same instance don't see the function.
    const dropSql = pg.compileDDL(dropFunction("compute_taxes_rt").build())
    await driver.execute(dropSql.sql, dropSql.params)
  })

  it("plpgsql body — BEGIN RETURN ...; END round-trips", async () => {
    const driver = pgliteDriver(pglite)
    const inc = createFunction("inc_rt")
      .args({ x: arg("integer") })
      .returns("integer")
      .languagePlpgsql()
      .body(({ x }) => add(x, val(1)))
      .build()
    const createSql = pg.compileDDL(inc.node)
    await driver.execute(createSql.sql, createSql.params)
    const r = await driver.query(`SELECT inc_rt(41) AS v`, [])
    expect(Number((r[0] as { v: number }).v)).toBe(42)
    const dropSql = pg.compileDDL(dropFunction("inc_rt").build())
    await driver.execute(dropSql.sql, dropSql.params)
  })
})
