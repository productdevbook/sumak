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
import { integer, serial, text } from "../../src/schema/column.ts"

// Issue #91 asks for database infrastructure to live in the codebase as typed
// code rather than in `.sql` files run by a deploy script. Phase 1 gave
// functions and triggers an expression body, and a function with an expression
// body is a SELECT with extra steps. Branches, loops, variables, RAISE and the
// row a trigger is handed are what made the request.
//
// Every test asks Postgres rather than comparing strings. A plpgsql body is a
// string literal to the outer parser, so a missing semicolon after `END IF`
// parses fine at CREATE time and fails only when the function is called.

const db = sumak({
  dialect: pgDialect(),
  tables: {
    products: { id: serial().primaryKey(), name: text().notNull(), price: integer().notNull() },
    audit: { id: serial().primaryKey(), action: text().notNull(), product: text().notNull() },
  },
})

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
  })

  it("names OLD, TG_OP and the table in lower case, which is what plpgsql resolves", () => {
    const fn = createFunction("describe_change")
      .returns("trigger")
      .orReplace()
      .plpgsql((b) => {
        b.raise("notice", "changed", {
          DETAIL: scope.op,
          TABLE: scope.table,
          COLUMN: scope.old.name,
        })
        b.return(typedCol("new"))
      })

    const sql = db.compileDDL(fn.buildNode()).sql
    expect(sql).toContain('DETAIL = "tg_op"')
    expect(sql).toContain('TABLE = "tg_table_name"')
    expect(sql).toContain('COLUMN = "old"."name"')
    expect(sql).not.toContain('"TG_OP"')
    expect(sql).not.toContain('"OLD"')
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

describe("the rest of the block, executed", () => {
  it("loops over a query with FOR and returns a running total", async () => {
    await pg.exec("DELETE FROM products")
    await pg.exec("INSERT INTO products (name, price) VALUES ('a', 3), ('b', 4), ('c', 5)")

    const fn = createFunction("total_prices")
      .returns("integer")
      .orReplace()
      .plpgsql((b) => {
        const total = b.declare<number>("total", "integer", { initial: val(0) })
        b.forEach("r", db.selectFrom("products").select("price").build(), (loop) => {
          loop.assign(total, typedAdd(total, typedCol<number>("price", "r")))
        })
        b.return(total)
      })

    await define(fn.buildNode())
    const result = await pg.query<{ total_prices: number }>("SELECT total_prices()")
    expect(result.rows[0]?.total_prices).toBe(12)
  })

  it("skips with CONTINUE WHEN", async () => {
    const fn = createFunction("sum_over_two")
      .args({ n: arg("integer") })
      .returns("integer")
      .orReplace()
      .plpgsql((b, { n }) => {
        const total = b.declare<number>("total", "integer", { initial: val(0) })
        b.forRange("i", val(1), n, (loop, i) => {
          loop.continue({ when: typedLte(i, val(2)) })
          loop.assign(total, typedAdd(total, i))
        })
        b.return(total)
      })

    await define(fn.buildNode())
    const result = await pg.query<{ sum_over_two: number }>("SELECT sum_over_two(5)")
    expect(result.rows[0]?.sum_over_two).toBe(12)
  })

  it("returns a set with RETURN NEXT", async () => {
    const fn = createFunction("first_n")
      .args({ n: arg("integer") })
      .returns("SETOF integer")
      .orReplace()
      .plpgsql((b, { n }) => {
        b.forRange("i", val(1), n, (loop, i) => {
          loop.returnNext(i)
        })
        b.return()
      })

    await define(fn.buildNode())
    const result = await pg.query<{ first_n: number }>("SELECT * FROM first_n(3)")
    expect(result.rows.map((r) => r.first_n)).toEqual([1, 2, 3])
  })

  it("returns a query with RETURN QUERY", async () => {
    await pg.exec("DELETE FROM products")
    await pg.exec("INSERT INTO products (name, price) VALUES ('x', 1), ('y', 2)")

    const fn = createFunction("all_prices")
      .returns("SETOF integer")
      .orReplace()
      .plpgsql((b) => {
        b.returnQuery(db.selectFrom("products").select("price").build())
      })

    await define(fn.buildNode())
    const result = await pg.query<{ all_prices: number }>("SELECT * FROM all_prices()")
    expect(result.rows.map((r) => r.all_prices).sort()).toEqual([1, 2])
  })

  it("opens a nested block with its own declarations", async () => {
    const fn = createFunction("nested_scope")
      .returns("integer")
      .orReplace()
      .plpgsql((b) => {
        const outer = b.declare<number>("outer_value", "integer", { initial: val(1) })
        b.block((inner) => {
          const shadowed = inner.declare<number>("inner_value", "integer", { initial: val(10) })
          inner.assign(outer, typedAdd(outer, shadowed))
        })
        b.return(outer)
      })

    await define(fn.buildNode())
    const result = await pg.query<{ nested_scope: number }>("SELECT nested_scope()")
    expect(result.rows[0]?.nested_scope).toBe(11)
  })

  it("does nothing, on purpose", async () => {
    const fn = createFunction("no_op")
      .args({ flag: arg("boolean") })
      .returns("integer")
      .orReplace()
      .plpgsql((b, { flag }) => {
        b.if(flag, (t) => t.nothing()).else((e) => e.raise("exception", "flag was false"))
        b.return(val(1))
      })

    await define(fn.buildNode())
    expect((await pg.query<{ no_op: number }>("SELECT no_op(true)")).rows[0]?.no_op).toBe(1)
    await expect(pg.query("SELECT no_op(false)")).rejects.toThrow(/flag was false/)
  })

  it("turns a declaration inside a branch into a block of its own", async () => {
    const fn = createFunction("branch_scope")
      .args({ flag: arg("boolean") })
      .returns("integer")
      .orReplace()
      .plpgsql((b, { flag }) => {
        b.if(flag, (t) => {
          // plpgsql only allows DECLARE at the head of a block, so this has to
          // become an inner BEGIN … END rather than a declaration on the outer
          // one — where it would also be in scope for the else branch.
          const local = t.declare<number>("local_value", "integer", { initial: val(4) })
          t.return(typedAdd(local, val(1)))
        }).else((e) => e.return(val(0)))
      })

    await define(fn.buildNode())
    expect(
      (await pg.query<{ branch_scope: number }>("SELECT branch_scope(true)")).rows[0]?.branch_scope,
    ).toBe(5)
    expect(
      (await pg.query<{ branch_scope: number }>("SELECT branch_scope(false)")).rows[0]
        ?.branch_scope,
    ).toBe(0)
  })

  it("carries only the RAISE options that were given", () => {
    const fn = createFunction("partial_raise")
      .returns("void")
      .orReplace()
      .plpgsql((b) => {
        b.raise("notice", "something", { DETAIL: val("d"), HINT: undefined })
      })

    const sql = db.compileDDL(fn.buildNode()).sql
    expect(sql).toContain("DETAIL = 'd'")
    expect(sql).not.toContain("HINT")
  })

  it("refuses an assignment target that is not a variable", () => {
    expect(() =>
      createFunction("bad_assign")
        .returns("void")
        .orReplace()
        .plpgsql((b) => {
          b.assign(typedAdd(val(1), val(2)) as never, val(3))
        }),
    ).toThrow(/needs a declared variable or an argument/)
  })

  it("assigns by name as well as by reference", async () => {
    const fn = createFunction("assign_by_name")
      .returns("integer")
      .orReplace()
      .plpgsql((b) => {
        b.declare<number>("counter", "integer", { initial: val(0) })
        b.assign("counter", val(7))
        b.return(typedCol<number>("counter"))
      })

    await define(fn.buildNode())
    const result = await pg.query<{ assign_by_name: number }>("SELECT assign_by_name()")
    expect(result.rows[0]?.assign_by_name).toBe(7)
  })
})

describe("the audit trigger from the issue", () => {
  const scope = triggerScope<{ id: number; name: string; price: number }>(["id", "name", "price"])

  it("writes NEW and TG_OP into another table", async () => {
    await pg.exec("DELETE FROM products; DELETE FROM audit")

    const fn = createFunction("audit_products")
      .returns("trigger")
      .orReplace()
      .plpgsql((b) => {
        // A branded expression reaches an INSERT as itself: `NEW.name` has no
        // value to bind, and inside $$ … $$ a placeholder would name one of the
        // function's own arguments.
        b.exec(db.insertInto("audit").values({ action: scope.op, product: scope.new.name }))
        b.return(typedCol("new"))
      })
    await define(fn.buildNode())

    const trigger = createTrigger("products_audit")
      .orReplace()
      .on("products")
      .after("INSERT")
      .forEachRow()
      .executeFunction("audit_products")
    await define(trigger.build())

    await pg.query("INSERT INTO products (name, price) VALUES ('widget', 5)")

    const rows = await pg.query<{ action: string; product: string }>(
      "SELECT action, product FROM audit",
    )
    expect(rows.rows).toEqual([{ action: "INSERT", product: "widget" }])
  })
})
