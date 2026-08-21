import { PGlite } from "@electric-sql/pglite"
import { beforeAll, describe, expect, it } from "vitest"

import {
  typedAdd,
  typedCol,
  typedGt,
  typedGte,
  typedLte,
  typedMul,
  typedSub,
} from "../../src/ast/typed-expression.ts"
import { createFunction } from "../../src/builder/ddl/function.ts"
import { triggerScope } from "../../src/builder/ddl/plpgsql.ts"
import { createTrigger } from "../../src/builder/ddl/trigger.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { arg, sumak, val } from "../../src/index.ts"

// Issue #91 asks for database infrastructure to live in the codebase as typed
// code rather than in `.sql` files run by a deploy script. Phase 1 gave
// functions and triggers an expression body, and a function with an expression
// body is a SELECT with extra steps. Branches, loops, variables, RAISE and the
// row a trigger is handed are what made the request.
//
// Every test asks Postgres rather than comparing strings. A plpgsql body is a
// string literal to the outer parser, so a missing semicolon after `END IF`
// parses fine at CREATE time and fails only when the function is called.

const db = sumak({ dialect: pgDialect(), tables: {} })

let pg: PGlite

async function define(node: Parameters<typeof db.compileDDL>[0]): Promise<void> {
  await pg.exec(db.compileDDL(node).sql)
}

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    CREATE TABLE products (id serial primary key, name text not null, price integer not null);
    CREATE TABLE audit (id serial primary key, action text not null, product text not null);
  `)
}, 60_000)

describe("a function body is code", () => {
  it("branches and raises", async () => {
    const fn = createFunction("compute_total")
      .args({ price: arg("integer"), quantity: arg("integer") })
      .returns("integer")
      .orReplace()
      .plpgsql((b, { price, quantity }) => {
        b.if(typedLte(quantity, val(0)), (t) => t.raise("exception", "quantity must be positive"))
        b.return(typedMul(price, quantity))
      })

    await define(fn.buildNode())

    const ok = await pg.query<{ compute_total: number }>("SELECT compute_total(10, 3)")
    expect(ok.rows[0]?.compute_total).toBe(30)

    await expect(pg.query("SELECT compute_total(10, 0)")).rejects.toThrow(
      /quantity must be positive/,
    )
  })

  it("declares a variable and loops over a range", async () => {
    const fn = createFunction("sum_to")
      .args({ n: arg("integer") })
      .returns("integer")
      .orReplace()
      .plpgsql((b, { n }) => {
        const total = b.declare<number>("total", "integer", { initial: val(0) })
        b.forRange("i", val(1), n, (loop, i) => {
          loop.assign(total, typedAdd(total, i))
        })
        b.return(total)
      })

    await define(fn.buildNode())
    const result = await pg.query<{ sum_to: number }>("SELECT sum_to(4)")
    expect(result.rows[0]?.sum_to).toBe(10)
  })

  it("exits a loop on a condition", async () => {
    const fn = createFunction("count_to")
      .args({ stop_at: arg("integer") })
      .returns("integer")
      .orReplace()
      .plpgsql((b, { stop_at }) => {
        const seen = b.declare<number>("seen", "integer", { initial: val(0) })
        b.loop((loop) => {
          loop.assign(seen, typedAdd(seen, val(1)))
          loop.exit({ when: typedGte(seen, stop_at) })
        })
        b.return(seen)
      })

    await define(fn.buildNode())
    const result = await pg.query<{ count_to: number }>("SELECT count_to(7)")
    expect(result.rows[0]?.count_to).toBe(7)
  })

  it("walks an elsif chain", async () => {
    const fn = createFunction("classify")
      .args({ score: arg("integer") })
      .returns("text")
      .orReplace()
      .plpgsql((b, { score }) => {
        b.if(typedGte(score, val(90)), (t) => t.return(val("high")))
          .elseIf(typedGte(score, val(50)), (t) => t.return(val("mid")))
          .else((e) => e.return(val("low")))
      })

    await define(fn.buildNode())
    for (const [input, expected] of [
      [95, "high"],
      [60, "mid"],
      [10, "low"],
    ] as const) {
      const result = await pg.query<{ classify: string }>(`SELECT classify(${input})`)
      expect(result.rows[0]?.classify).toBe(expected)
    }
  })

  it("runs a while loop", async () => {
    const fn = createFunction("countdown")
      .args({ start_at: arg("integer") })
      .returns("integer")
      .orReplace()
      .plpgsql((b, { start_at }) => {
        const n = b.declare<number>("n", "integer", { initial: start_at })
        const steps = b.declare<number>("steps", "integer", { initial: val(0) })
        b.while(typedGt(n, val(0)), (loop) => {
          loop.assign(n, typedSub(n, val(1)))
          loop.assign(steps, typedAdd(steps, val(1)))
        })
        b.return(steps)
      })

    await define(fn.buildNode())
    const result = await pg.query<{ countdown: number }>("SELECT countdown(6)")
    expect(result.rows[0]?.countdown).toBe(6)
  })

  it("refuses a statement body that is not plpgsql", () => {
    const fn = createFunction("bad")
      .returns("integer")
      .plpgsql((b) => b.return(val(1)))
      .languageSql()
    expect(() => db.compileDDL(fn.buildNode())).toThrow(/needs LANGUAGE plpgsql/)
  })

  it("refuses a parameter inside an embedded statement", () => {
    const withParam = sumak({
      dialect: pgDialect(),
      tables: {},
    })
    const fn = createFunction("bad_embed")
      .returns("void")
      .plpgsql((b) => {
        b.perform({
          type: "select",
          columns: [],
          joins: [],
          groupBy: [],
          orderBy: [],
          ctes: [],
          distinct: false,
          where: { type: "param", index: 0, value: 1 },
        } as never)
      })
    expect(() => withParam.compileDDL(fn.buildNode())).toThrow(/cannot carry parameters/)
  })
})

describe("a trigger sees its row", () => {
  const scope = triggerScope<{ id: number; name: string; price: number }>(["id", "name", "price"])

  it("names NEW, OLD and TG_OP", () => {
    const fn = createFunction("guard_price")
      .returns("trigger")
      .orReplace()
      .plpgsql((b) => {
        b.if(typedLte(scope.new.price, val(0)), (t) =>
          t.raise("exception", "price must be positive"),
        )
        b.return(scope.new.id)
      })

    const sql = db.compileDDL(fn.buildNode()).sql
    expect(sql).toContain('"new"."price"')
    expect(sql).toContain("RAISE EXCEPTION")
    expect(scope.old.name).toBeDefined()
    expect(scope.op).toBeDefined()
  })

  it("fires against a real table and rejects the row", async () => {
    const fn = createFunction("guard_price")
      .returns("trigger")
      .orReplace()
      .plpgsql((b) => {
        b.if(typedLte(scope.new.price, val(0)), (t) =>
          t.raise("exception", "price must be positive"),
        )
        b.return(typedCol("new"))
      })
    await define(fn.buildNode())

    const trigger = createTrigger("products_guard")
      .orReplace()
      .on("products")
      .before("INSERT")
      .forEachRow()
      .executeFunction("guard_price")
    await define(trigger.build())

    await pg.query("INSERT INTO products (name, price) VALUES ('ok', 10)")
    await expect(pg.query("INSERT INTO products (name, price) VALUES ('bad', 0)")).rejects.toThrow(
      /price must be positive/,
    )

    const rows = await pg.query<{ count: number }>("SELECT count(*)::int AS count FROM products")
    expect(rows.rows[0]?.count).toBe(1)
  })
})
