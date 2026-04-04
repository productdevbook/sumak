import { describe, expect, it } from "vitest"

import { col, eq, lit, param, star } from "../../src/ast/expression.ts"
import type { DeleteNode, InsertNode, SelectNode, UpdateNode } from "../../src/ast/nodes.ts"
import {
  createDeleteNode,
  createInsertNode,
  createSelectNode,
  createUpdateNode,
} from "../../src/ast/nodes.ts"
import { MssqlPrinter } from "../../src/printer/mssql.ts"

function printer() {
  return new MssqlPrinter()
}

describe("MssqlPrinter", () => {
  describe("SELECT", () => {
    it("prints basic SELECT", () => {
      const node: SelectNode = {
        ...createSelectNode(),
        columns: [col("id"), col("name")],
        from: { type: "table_ref", name: "users" },
      }
      const r = printer().print(node)
      expect(r.sql).toBe("SELECT [id], [name] FROM [users]")
    })

    it("uses square bracket quoting", () => {
      const node: SelectNode = {
        ...createSelectNode(),
        columns: [col("id")],
        from: { type: "table_ref", name: "users" },
      }
      expect(printer().print(node).sql).toBe("SELECT [id] FROM [users]")
    })

    it("uses @p params", () => {
      const node: SelectNode = {
        ...createSelectNode(),
        columns: [star()],
        from: { type: "table_ref", name: "users" },
        where: eq(col("id"), param(0, 42)),
      }
      const r = printer().print(node)
      expect(r.sql).toBe("SELECT * FROM [users] WHERE ([id] = @p0)")
      expect(r.params).toEqual([42])
    })

    it("uses TOP N for LIMIT without OFFSET", () => {
      const node: SelectNode = {
        ...createSelectNode(),
        columns: [star()],
        from: { type: "table_ref", name: "users" },
        limit: lit(10),
      }
      expect(printer().print(node).sql).toBe("SELECT TOP 10 * FROM [users]")
    })

    it("uses OFFSET/FETCH for LIMIT with OFFSET", () => {
      const node: SelectNode = {
        ...createSelectNode(),
        columns: [star()],
        from: { type: "table_ref", name: "users" },
        orderBy: [{ expr: col("id"), direction: "ASC" }],
        limit: lit(10),
        offset: lit(20),
      }
      const r = printer().print(node)
      expect(r.sql).toBe(
        "SELECT * FROM [users] ORDER BY [id] ASC OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY",
      )
    })

    it("uses OFFSET without FETCH when no LIMIT", () => {
      const node: SelectNode = {
        ...createSelectNode(),
        columns: [star()],
        from: { type: "table_ref", name: "users" },
        orderBy: [{ expr: col("id"), direction: "ASC" }],
        offset: lit(5),
      }
      const r = printer().print(node)
      expect(r.sql).toBe("SELECT * FROM [users] ORDER BY [id] ASC OFFSET 5 ROWS")
    })

    it("throws on FOR UPDATE", () => {
      const node: SelectNode = {
        ...createSelectNode(),
        columns: [star()],
        from: { type: "table_ref", name: "users" },
        forUpdate: true,
      }
      expect(() => printer().print(node)).toThrow("FOR UPDATE")
    })
  })

  describe("INSERT", () => {
    it("prints basic INSERT", () => {
      const node: InsertNode = {
        ...createInsertNode({ type: "table_ref", name: "users" }),
        columns: ["name", "email"],
        values: [[param(0, "Alice"), param(1, "a@b.com")]],
      }
      const r = printer().print(node)
      expect(r.sql).toBe("INSERT INTO [users] ([name], [email]) VALUES (@p0, @p1)")
      expect(r.params).toEqual(["Alice", "a@b.com"])
    })

    it("uses OUTPUT INSERTED for RETURNING *", () => {
      const node: InsertNode = {
        ...createInsertNode({ type: "table_ref", name: "users" }),
        columns: ["name"],
        values: [[param(0, "Alice")]],
        returning: [star()],
      }
      const r = printer().print(node)
      expect(r.sql).toBe("INSERT INTO [users] ([name]) OUTPUT INSERTED.* VALUES (@p0)")
    })

    it("uses OUTPUT INSERTED for RETURNING specific columns", () => {
      const node: InsertNode = {
        ...createInsertNode({ type: "table_ref", name: "users" }),
        columns: ["name"],
        values: [[param(0, "Alice")]],
        returning: [col("id"), col("name")],
      }
      const r = printer().print(node)
      expect(r.sql).toContain("OUTPUT INSERTED.[id], INSERTED.[name]")
    })

    it("throws on ON CONFLICT", () => {
      const node: InsertNode = {
        ...createInsertNode({ type: "table_ref", name: "users" }),
        columns: ["name"],
        values: [[param(0, "Alice")]],
        onConflict: { columns: ["name"], action: "nothing" },
      }
      expect(() => printer().print(node)).toThrow("ON CONFLICT")
    })
  })

  describe("UPDATE", () => {
    it("prints basic UPDATE", () => {
      const node: UpdateNode = {
        ...createUpdateNode({ type: "table_ref", name: "users" }),
        set: [{ column: "name", value: param(0, "Bob") }],
        where: eq(col("id"), param(1, 1)),
      }
      const r = printer().print(node)
      expect(r.sql).toBe("UPDATE [users] SET [name] = @p0 WHERE ([id] = @p1)")
      expect(r.params).toEqual(["Bob", 1])
    })

    it("uses OUTPUT INSERTED for RETURNING", () => {
      const node: UpdateNode = {
        ...createUpdateNode({ type: "table_ref", name: "users" }),
        set: [{ column: "name", value: param(0, "Bob") }],
        returning: [star()],
      }
      const r = printer().print(node)
      expect(r.sql).toContain("OUTPUT INSERTED.*")
    })
  })

  describe("DELETE", () => {
    it("prints basic DELETE", () => {
      const node: DeleteNode = {
        ...createDeleteNode({ type: "table_ref", name: "users" }),
        where: eq(col("id"), param(0, 1)),
      }
      const r = printer().print(node)
      expect(r.sql).toBe("DELETE FROM [users] WHERE ([id] = @p0)")
      expect(r.params).toEqual([1])
    })

    it("uses OUTPUT DELETED for RETURNING", () => {
      const node: DeleteNode = {
        ...createDeleteNode({ type: "table_ref", name: "users" }),
        returning: [star()],
        where: eq(col("id"), param(0, 1)),
      }
      const r = printer().print(node)
      expect(r.sql).toContain("OUTPUT DELETED.*")
    })

    it("uses OUTPUT DELETED for specific columns", () => {
      const node: DeleteNode = {
        ...createDeleteNode({ type: "table_ref", name: "users" }),
        returning: [col("id")],
        where: eq(col("id"), param(0, 1)),
      }
      const r = printer().print(node)
      expect(r.sql).toContain("OUTPUT DELETED.[id]")
    })
  })
})
