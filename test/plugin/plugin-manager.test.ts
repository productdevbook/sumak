import { describe, expect, it } from "vitest"

import { createSelectNode } from "../../src/ast/nodes.ts"
import type { ASTNode } from "../../src/ast/nodes.ts"
import { PluginManager } from "../../src/plugin/plugin-manager.ts"
import type { SumakPlugin } from "../../src/plugin/types.ts"

describe("PluginManager", () => {
  it("applies transformNode plugins in order", () => {
    const log: string[] = []
    const p1: SumakPlugin = {
      name: "p1",
      transformNode(node: ASTNode) {
        log.push("p1")
        return node
      },
    }
    const p2: SumakPlugin = {
      name: "p2",
      transformNode(node: ASTNode) {
        log.push("p2")
        return node
      },
    }

    const pm = new PluginManager([p1, p2])
    pm.transformNode(createSelectNode())
    expect(log).toEqual(["p1", "p2"])
  })

  it("applies transformResult plugins in order", () => {
    const p1: SumakPlugin = {
      name: "p1",
      transformResult(rows) {
        return rows.map((r) => ({ ...r, p1: true }))
      },
    }
    const pm = new PluginManager([p1])
    const result = pm.transformResult([{ id: 1 }])
    expect(result[0]).toEqual({ id: 1, p1: true })
  })

  it("skips plugins without the relevant method", () => {
    const p1: SumakPlugin = { name: "p1" }
    const pm = new PluginManager([p1])

    const node = createSelectNode()
    expect(pm.transformNode(node)).toBe(node)
    expect(pm.transformResult([{ a: 1 }])).toEqual([{ a: 1 }])
  })
})
