import { describe, expect, it } from "vitest"

import { arr, ast, num, pgDialect, str, sumak, val, win } from "../../src/index.ts"

describe("namespaces — win", () => {
  it("exposes window functions", () => {
    expect(typeof win.rowNumber).toBe("function")
    expect(typeof win.rank).toBe("function")
    expect(typeof win.denseRank).toBe("function")
    expect(typeof win.lag).toBe("function")
    expect(typeof win.lead).toBe("function")
    expect(typeof win.ntile).toBe("function")
    expect(typeof win.over).toBe("function")
    expect(typeof win.filter).toBe("function")
  })

  it("win.rank() is callable and produces an Expression", () => {
    const expr = win.rank()
    expect(expr).toBeTruthy()
  })
})

describe("namespaces — str", () => {
  it("exposes string functions", () => {
    expect(typeof str.upper).toBe("function")
    expect(typeof str.lower).toBe("function")
    expect(typeof str.concat).toBe("function")
    expect(typeof str.substring).toBe("function")
    expect(typeof str.trim).toBe("function")
    expect(typeof str.length).toBe("function")
  })
})

describe("namespaces — num", () => {
  it("exposes math functions", () => {
    expect(typeof num.abs).toBe("function")
    expect(typeof num.round).toBe("function")
    expect(typeof num.ceil).toBe("function")
    expect(typeof num.floor).toBe("function")
    expect(typeof num.greatest).toBe("function")
    expect(typeof num.least).toBe("function")
  })
})

describe("namespaces — arr", () => {
  it("exposes PG array operators", () => {
    expect(typeof arr.contains).toBe("function")
    expect(typeof arr.containedBy).toBe("function")
    expect(typeof arr.overlaps).toBe("function")
  })
})

describe("namespaces — ast", () => {
  it("exposes node factories and low-level expression factories", () => {
    expect(typeof ast.select).toBe("function")
    expect(typeof ast.insert).toBe("function")
    expect(typeof ast.update).toBe("function")
    expect(typeof ast.delete).toBe("function")
    expect(typeof ast.merge).toBe("function")
    expect(typeof ast.table).toBe("function")
    expect(typeof ast.col).toBe("function")
    expect(typeof ast.lit).toBe("function")
    expect(typeof ast.binOp).toBe("function")
    expect(typeof ast.visit).toBe("function")
  })

  it("ast.binOp builds a frozen-shape node", () => {
    const node = ast.binOp("=", ast.col("id"), ast.lit(1))
    expect(node.type).toBe("binary_op")
    expect(node.op).toBe("=")
  })
})

describe("namespaces — smoke integration with builder", () => {
  it("works with an actual sumak instance", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: {
        sales: {} as any,
      },
    })
    expect(num.abs(val(-3) as any)).toBeTruthy()
    expect(str.upper(val("hi") as any)).toBeTruthy()
    void db
  })
})
