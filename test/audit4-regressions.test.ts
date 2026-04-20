import { describe, expect, it } from "vitest"

import type { ExpressionNode, SelectNode } from "../src/ast/nodes.ts"
import { createSelectNode, tableRef } from "../src/ast/nodes.ts"
import { sql } from "../src/builder/sql.ts"
import { pgDialect } from "../src/dialect/pg.ts"
import { withSchema } from "../src/plugin/factories.ts"
import { OptimisticLockPlugin } from "../src/plugin/optimistic-lock.ts"
import { MssqlPrinter } from "../src/printer/mssql.ts"
import { MysqlPrinter } from "../src/printer/mysql.ts"
import { SqlitePrinter } from "../src/printer/sqlite.ts"
import { integer, serial, text } from "../src/schema/column.ts"
import { sumak } from "../src/sumak.ts"

describe("Audit #4 regressions", () => {
  describe("sql`` template — __PARAM_N__ substitution", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
    })

    it("single interpolation becomes a dialect placeholder, not a literal sentinel", () => {
      const q = db
        .selectFrom("users")
        .where(() => sql<boolean>`id = ${42}`)
        .select("id")
        .toSQL()
      expect(q.sql).toContain("id = $1")
      expect(q.sql).not.toContain("__PARAM")
      expect(q.params).toEqual([42])
    })

    it("multiple interpolations combine with surrounding params at the correct offsets", () => {
      const q = db
        .selectFrom("users")
        .where(({ name }) => name.eq("Alice"))
        .where(() => sql<boolean>`id > ${5} AND id < ${100}`)
        .select("id")
        .toSQL()
      // "Alice" is $1, then sql`` params slot in at $2 / $3
      expect(q.sql).toContain("id > $2 AND id < $3")
      expect(q.params).toEqual(["Alice", 5, 100])
    })

    it("MySQL uses `?` placeholders for interpolations", () => {
      const printer = new MysqlPrinter()
      const node: SelectNode = {
        ...createSelectNode(),
        from: tableRef("users"),
        columns: [{ type: "star" }],
        where: (sql<boolean>`id = ${7}` as any).node as ExpressionNode,
      }
      const r = printer.print(node)
      expect(r.sql).toContain("id = ?")
      expect(r.params).toEqual([7])
    })

    it("MSSQL uses `@pN` placeholders for interpolations", () => {
      const printer = new MssqlPrinter()
      const node: SelectNode = {
        ...createSelectNode(),
        from: tableRef("users"),
        columns: [{ type: "star" }],
        where: (sql<boolean>`id = ${7}` as any).node as ExpressionNode,
      }
      const r = printer.print(node)
      expect(r.sql).toContain("id = @p0")
      expect(r.params).toEqual([7])
    })

    it("SQLite uses `?` placeholders for interpolations", () => {
      const printer = new SqlitePrinter()
      const node: SelectNode = {
        ...createSelectNode(),
        from: tableRef("users"),
        columns: [{ type: "star" }],
        where: (sql<boolean>`id = ${7}` as any).node as ExpressionNode,
      }
      const r = printer.print(node)
      expect(r.sql).toContain("id = ?")
      expect(r.params).toEqual([7])
    })
  })

  describe("sql`` template — complex expression rejection", () => {
    it("throws with a helpful message instead of emitting `(?)`", () => {
      // A case expression is a "complex" node the template can't inline.
      const complexExpr = {
        node: {
          type: "case",
          whens: [
            { condition: { type: "literal", value: true }, result: { type: "literal", value: 1 } },
          ],
          else_: { type: "literal", value: 0 },
        },
      }
      expect(() => sql`SELECT ${complexExpr as any} FROM t`).toThrow(
        /cannot inline a case expression/,
      )
    })
  })

  describe("WithSchemaPlugin — MERGE support", () => {
    const db = sumak({
      dialect: pgDialect(),
      plugins: [withSchema("tenant_1")],
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull() },
        staging: { id: serial().primaryKey(), name: text().notNull() },
      },
    })

    it("qualifies both target and source tables in a MERGE", () => {
      const q = db
        .mergeInto("users", {
          source: "staging",
          alias: "s",
          on: ({ target, source }) => target.id.eq(source.id),
        })
        .whenMatchedThenUpdate({ name: "x" })
        .toSQL()
      expect(q.sql).toContain('"tenant_1"."users"')
      expect(q.sql).toContain('"tenant_1"."staging"')
    })

    it("derives a sane alias when the caller omits `alias`", () => {
      // Without an alias the scoped mergeInto used to pass the
      // fully-qualified name (`"tenant_1.staging"`) through to
      // `Sumak.mergeInto`'s default alias fallback, which then emitted
      // a single broken identifier `"tenant_1.staging"` in the ON clause.
      // Now we derive the alias from the last segment of the source.
      const q = db
        .mergeInto("users", {
          source: "staging",
          on: ({ target, source }) => target.id.eq(source.id),
        })
        .whenMatchedThenUpdate({ name: "x" })
        .toSQL()
      expect(q.sql).toContain('"tenant_1"."staging"')
      // The alias is `staging` (the last segment), not `tenant_1.staging`.
      expect(q.sql).toContain('"staging"."id"')
      expect(q.sql).not.toContain('"tenant_1.staging"')
    })
  })

  describe("OptimisticLockPlugin idempotency", () => {
    it("double-registering the plugin does not duplicate the version SET", () => {
      let version = 5
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          new OptimisticLockPlugin({ tables: ["users"], currentVersion: () => version }),
          new OptimisticLockPlugin({ tables: ["users"], currentVersion: () => version }),
        ],
        tables: {
          users: {
            id: serial().primaryKey(),
            name: text().notNull(),
            version: integer().defaultTo(0),
          },
        },
      })
      const q = db
        .update("users")
        .set({ name: "Bob" })
        .where(({ id }) => id.eq(1))
        .toSQL()
      // The `"version" = ("version" + 1)` SET entry must appear exactly
      // once — doubling it is the bug a double-registered plugin would
      // produce without the idempotency flag.
      const setMatches = q.sql.match(/"version" = \("version" \+ 1\)/g) ?? []
      expect(setMatches.length).toBe(1)
    })
  })

  describe("deduplicatePredicates — EXISTS / subquery fingerprints include body", () => {
    it("two different EXISTS predicates are not collapsed", async () => {
      const { deduplicatePredicates } = await import("../src/normalize/expression.ts")
      const left: ExpressionNode = {
        type: "exists",
        negated: false,
        query: {
          ...createSelectNode(),
          from: tableRef("a"),
          columns: [{ type: "star" }],
        },
      }
      const right: ExpressionNode = {
        type: "exists",
        negated: false,
        query: {
          ...createSelectNode(),
          from: tableRef("b"),
          columns: [{ type: "star" }],
        },
      }
      const and: ExpressionNode = { type: "binary_op", op: "AND", left, right }
      const after = deduplicatePredicates(and)
      // Still an AND — the two EXISTS have different bodies, must not merge.
      expect(after.type).toBe("binary_op")
    })
  })
})
