import { describe, expect, it } from "vitest"

import { col, eq, gt, lit, lt } from "../../src/ast/expression.ts"
import { DeleteBuilder } from "../../src/builder/delete.ts"
import { SelectBuilder } from "../../src/builder/select.ts"
import { UpdateBuilder } from "../../src/builder/update.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      age: integer(),
    },
  },
})

const p = db.printer()

describe("Multiple .where() with implicit AND", () => {
  describe("SelectBuilder (untyped)", () => {
    it("single where works as before", () => {
      const q = new SelectBuilder()
        .allColumns()
        .from("users")
        .where(eq(col("id"), lit(1)))
        .build()
      expect(q.where).toBeDefined()
      expect(q.where!.type).toBe("binary_op")
    })

    it("two where() calls produce AND", () => {
      const q = new SelectBuilder()
        .allColumns()
        .from("users")
        .where(eq(col("id"), lit(1)))
        .where(gt(col("age"), lit(18)))
        .build()
      expect(q.where!.type).toBe("binary_op")
      const w = q.where as any
      expect(w.op).toBe("AND")
      expect(w.left.op).toBe("=")
      expect(w.right.op).toBe(">")
    })

    it("three where() calls chain ANDs", () => {
      const q = new SelectBuilder()
        .allColumns()
        .from("users")
        .where(eq(col("id"), lit(1)))
        .where(gt(col("age"), lit(18)))
        .where(lt(col("age"), lit(65)))
        .build()
      const w = q.where as any
      expect(w.op).toBe("AND")
      // (id = 1 AND age > 18) AND age < 65
      expect(w.left.op).toBe("AND")
      expect(w.right.op).toBe("<")
    })
  })

  describe("TypedSelectBuilder", () => {
    it("multiple .where() calls produce AND", () => {
      const q = db
        .selectFrom("users")
        .select("id", "name")
        .where(({ id }) => id.eq(1))
        .where(({ age }) => age.gt(18))
        .compile(p)
      expect(q.sql).toContain("AND")
    })
  })

  describe("UpdateBuilder (untyped)", () => {
    it("multiple where() calls produce AND", () => {
      const q = new UpdateBuilder()
        .table("users")
        .set("name", lit("Alice"))
        .where(eq(col("id"), lit(1)))
        .where(gt(col("age"), lit(18)))
        .build()
      const w = q.where as any
      expect(w.op).toBe("AND")
    })
  })

  describe("TypedUpdateBuilder", () => {
    it("multiple .where() calls produce AND", () => {
      const q = db
        .update("users")
        .set({ name: "Alice" })
        .where(({ id }) => id.eq(1))
        .where(({ age }) => age.gt(18))
        .compile(p)
      expect(q.sql).toContain("AND")
    })
  })

  describe("DeleteBuilder (untyped)", () => {
    it("multiple where() calls produce AND", () => {
      const q = new DeleteBuilder()
        .from("users")
        .where(eq(col("id"), lit(1)))
        .where(gt(col("age"), lit(18)))
        .build()
      const w = q.where as any
      expect(w.op).toBe("AND")
    })
  })

  describe("TypedDeleteBuilder", () => {
    it("multiple .where() calls produce AND", () => {
      const q = db
        .deleteFrom("users")
        .where(({ id }) => id.eq(1))
        .where(({ age }) => age.gt(18))
        .compile(p)
      expect(q.sql).toContain("AND")
    })
  })
})
