import { describe, expect, it } from "vitest"

import {
  createDeleteNode,
  createInsertNode,
  createSelectNode,
  createUpdateNode,
} from "../../src/ast/nodes.ts"

describe("AST Node Factories", () => {
  describe("createSelectNode", () => {
    it("creates a default select node", () => {
      const node = createSelectNode()
      expect(node.type).toBe("select")
      expect(node.distinct).toBe(false)
      expect(node.columns).toEqual([])
      expect(node.joins).toEqual([])
      expect(node.groupBy).toEqual([])
      expect(node.orderBy).toEqual([])
      expect(node.ctes).toEqual([])
      expect(node.lock).toBeUndefined()
      expect(node.from).toBeUndefined()
      expect(node.where).toBeUndefined()
      expect(node.having).toBeUndefined()
      expect(node.limit).toBeUndefined()
      expect(node.offset).toBeUndefined()
    })
  })

  describe("createInsertNode", () => {
    it("creates an insert node with table", () => {
      const node = createInsertNode({ type: "table_ref", name: "users" })
      expect(node.type).toBe("insert")
      expect(node.table.name).toBe("users")
      expect(node.columns).toEqual([])
      expect(node.values).toEqual([])
      expect(node.returning).toEqual([])
      expect(node.ctes).toEqual([])
    })
  })

  describe("createUpdateNode", () => {
    it("creates an update node with table", () => {
      const node = createUpdateNode({ type: "table_ref", name: "users" })
      expect(node.type).toBe("update")
      expect(node.table.name).toBe("users")
      expect(node.set).toEqual([])
      expect(node.returning).toEqual([])
      expect(node.ctes).toEqual([])
      expect(node.where).toBeUndefined()
    })
  })

  describe("createDeleteNode", () => {
    it("creates a delete node with table", () => {
      const node = createDeleteNode({ type: "table_ref", name: "users" })
      expect(node.type).toBe("delete")
      expect(node.table.name).toBe("users")
      expect(node.returning).toEqual([])
      expect(node.ctes).toEqual([])
      expect(node.where).toBeUndefined()
    })
  })
})
