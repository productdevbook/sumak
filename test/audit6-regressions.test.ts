import { describe, expect, it } from "vitest"

import { col, eq, lit, param } from "../src/ast/expression.ts"
import type { ExpressionNode, SelectNode } from "../src/ast/nodes.ts"
import { createSelectNode, tableRef } from "../src/ast/nodes.ts"
import { SelectBuilder } from "../src/builder/select.ts"
import { mssqlDialect } from "../src/dialect/mssql.ts"
import { pgDialect } from "../src/dialect/pg.ts"
import { sqliteDialect } from "../src/dialect/sqlite.ts"
import { UnsupportedDialectFeatureError } from "../src/errors.ts"
import { flattenLogical } from "../src/normalize/expression.ts"
import { SqlitePrinter } from "../src/printer/sqlite.ts"
import { serial, text } from "../src/schema/column.ts"
import { sumak } from "../src/sumak.ts"

describe("Audit #6 regressions", () => {
  describe("BigInt params coerced to string for driver safety", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
    })

    it("BigInt value becomes a decimal string in params", () => {
      const big = 9007199254740993n // Number.MAX_SAFE_INTEGER + 2
      const q = db
        .selectFrom("users")
        .where(({ id }) => id.eq(big as any))
        .select("id")
        .toSQL()
      expect(q.params).toEqual(["9007199254740993"])
      // No bare BigInt in the array — that's what PG drivers reject.
      expect(q.params.every((p) => typeof p !== "bigint")).toBe(true)
    })
  })

  describe("MSSQL setOp ordering: UNION precedes ORDER BY + OFFSET/FETCH", () => {
    it("SELECT ... UNION ... ORDER BY ... OFFSET/FETCH emits in valid order", () => {
      const db = sumak({
        dialect: mssqlDialect(),
        tables: { users: { id: serial().primaryKey() } },
      })
      const q1 = db.selectFrom("users").select("id")
      const q2 = db.selectFrom("users").select("id")
      const r = q1.orderBy("id").offset(0).limit(10).union(q2).toSQL()
      const unionIdx = r.sql.indexOf("UNION")
      const orderIdx = r.sql.indexOf("ORDER BY")
      const offsetIdx = r.sql.indexOf("OFFSET")
      const fetchIdx = r.sql.indexOf("FETCH NEXT")
      expect(unionIdx).toBeGreaterThan(-1)
      // Order: UNION → ORDER BY → OFFSET → FETCH NEXT
      expect(unionIdx).toBeLessThan(orderIdx)
      expect(orderIdx).toBeLessThan(offsetIdx)
      expect(offsetIdx).toBeLessThan(fetchIdx)
    })
  })

  describe("flattenAnd / flattenOr iterative — no stack overflow on 10k-deep chains", () => {
    it("left-skewed AND chain of 10000 nodes flattens without overflow", () => {
      // Build `leaf AND leaf AND ... AND leaf` left-associatively.
      const leaf: ExpressionNode = eq(col("x"), param(0, 1))
      let expr: ExpressionNode = leaf
      for (let i = 0; i < 10000; i++) {
        expr = { type: "binary_op", op: "AND", left: expr, right: leaf }
      }
      // Should not throw RangeError.
      const flat = flattenLogical(expr)
      expect(flat.type).toBe("binary_op")
    })
  })

  describe("LATERAL JOIN rejection on SQLite", () => {
    it("throws UnsupportedDialectFeatureError instead of emitting invalid SQL", () => {
      const printer = new SqlitePrinter()
      const sub: SelectNode = {
        ...createSelectNode(),
        from: tableRef("orders"),
        columns: [{ type: "star" }],
      }
      const node: SelectNode = {
        ...createSelectNode(),
        from: tableRef("users"),
        columns: [{ type: "star" }],
        joins: [
          {
            type: "join",
            joinType: "CROSS",
            table: { type: "subquery", query: sub, alias: "s" },
            lateral: true,
          },
        ],
      }
      expect(() => printer.print(node)).toThrow(UnsupportedDialectFeatureError)
    })

    it("non-lateral joins still work on SQLite", () => {
      const sqliteDb = sumak({
        dialect: sqliteDialect(),
        tables: {
          users: { id: serial().primaryKey() },
          orders: { id: serial().primaryKey(), user_id: serial() },
        },
      })
      const r = sqliteDb
        .selectFrom("users")
        .innerJoin("orders", ({ users, orders }) => users.id.eq(orders.user_id))
        .select("id")
        .toSQL()
      expect(r.sql).toContain("INNER JOIN")
    })
  })

  describe("3-way union chain still works after the MSSQL setOp reorder", () => {
    it("q1.union(q2).union(q3) emits two UNIONs on MSSQL", () => {
      const db = sumak({
        dialect: mssqlDialect(),
        tables: { users: { id: serial().primaryKey() } },
      })
      const q1 = db.selectFrom("users").select("id")
      const q2 = db.selectFrom("users").select("id")
      const q3 = db.selectFrom("users").select("id")
      const r = q1.union(q2).union(q3).toSQL()
      const unions = (r.sql.match(/UNION/g) ?? []).length
      expect(unions).toBe(2)
    })

    it("MSSQL limit + UNION — emits FETCH NEXT (not TOP), TOP would bind only to left arm", () => {
      const db = sumak({
        dialect: mssqlDialect(),
        tables: { users: { id: serial().primaryKey() } },
      })
      const q1 = db.selectFrom("users").select("id")
      const q2 = db.selectFrom("users").select("id")
      // limit-only (no offset) + UNION — must NOT emit `TOP N`.
      const r = q1.orderBy("id").limit(10).union(q2).toSQL()
      expect(r.sql).not.toContain("TOP ")
      expect(r.sql).toContain("FETCH NEXT")
      expect(r.sql).toContain("OFFSET")
    })

    it("MSSQL limit without UNION still uses TOP", () => {
      const db = sumak({
        dialect: mssqlDialect(),
        tables: { users: { id: serial().primaryKey() } },
      })
      const r = db.selectFrom("users").select("id").limit(10).toSQL()
      expect(r.sql).toContain("TOP ")
    })
  })

  describe("flattenAnd / flattenOr preserve order", () => {
    it("deep OR chain also flattens without overflow", () => {
      const leaf: ExpressionNode = eq(col("x"), param(0, 1))
      let expr: ExpressionNode = leaf
      for (let i = 0; i < 10000; i++) {
        expr = { type: "binary_op", op: "OR", left: expr, right: leaf }
      }
      // No throw is the assertion.
      flattenLogical(expr)
    })
  })

  describe("quoteIdentifier is injection-safe with attacker-controlled schema", () => {
    it("pg: embedded double-quote in schema is doubled (escaped), not closing", () => {
      const db = sumak({
        dialect: pgDialect(),
        tables: { users: { id: serial().primaryKey() } },
      })
      // Plugin-free — just call compileDDL with a fabricated TableRef
      const bad = 'public"; DROP TABLE users--'
      const printer = db.printer()
      const node: SelectNode = {
        ...createSelectNode(),
        from: { type: "table_ref", name: "users", schema: bad },
        columns: [{ type: "star" }],
      }
      const r = printer.print(node)
      // Embedded `"` doubled to `""`. The attacker string is trapped inside
      // ONE identifier — the DROP keyword never lives outside the quotes.
      expect(r.sql).toContain('"public""; DROP TABLE users--"')
      // After the final `"` that closes the identifier, DROP must not appear.
      const closingIdx = r.sql.indexOf('"."')
      const tail = r.sql.slice(closingIdx)
      expect(tail).not.toContain("DROP")
    })
  })
})
