import { describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { boolean, integer, interval, serial, text, varchar } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

describe("ColumnBuilder enhancements", () => {
  it("stores default value", () => {
    const col = boolean().defaultTo(true)
    expect(col._def.hasDefault).toBe(true)
    expect(col._def.defaultValue).toBe(true)
  })

  it("stores string default", () => {
    const col = text().defaultTo("hello")
    expect(col._def.defaultValue).toBe("hello")
  })

  it("stores numeric default", () => {
    const col = integer().defaultTo(0)
    expect(col._def.defaultValue).toBe(0)
  })

  it("unique flag", () => {
    const col = text().unique()
    expect(col._def.isUnique).toBe(true)
  })

  it("references with onDelete", () => {
    const col = integer().references("users", "id").onDelete("CASCADE")
    expect(col._def.references!.onDelete).toBe("CASCADE")
  })

  it("references with onUpdate", () => {
    const col = integer().references("users", "id").onUpdate("SET NULL")
    expect(col._def.references!.onUpdate).toBe("SET NULL")
  })

  it("references with both onDelete and onUpdate", () => {
    const col = integer().references("users", "id").onDelete("CASCADE").onUpdate("NO ACTION")
    expect(col._def.references!.onDelete).toBe("CASCADE")
    expect(col._def.references!.onUpdate).toBe("NO ACTION")
  })

  it("onDelete without references is no-op", () => {
    const col = integer().onDelete("CASCADE")
    expect(col._def.references).toBeUndefined()
  })

  it("interval column type", () => {
    const col = interval()
    expect(col._def.dataType).toBe("interval")
  })
})

describe("generateDDL with enhanced columns", () => {
  it("generates DEFAULT value", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: {
        users: {
          id: serial().primaryKey(),
          active: boolean().defaultTo(true),
          score: integer().defaultTo(0),
        },
      },
    })
    const ddl = db.generateDDL()
    expect(ddl[0]!.sql).toContain("DEFAULT TRUE")
    expect(ddl[0]!.sql).toContain("DEFAULT 0")
  })

  it("generates UNIQUE", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: {
        users: {
          id: serial().primaryKey(),
          email: text().notNull().unique(),
        },
      },
    })
    const ddl = db.generateDDL()
    expect(ddl[0]!.sql).toContain("UNIQUE")
  })

  it("generates ON DELETE CASCADE", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: {
        posts: {
          id: serial().primaryKey(),
          userId: integer().references("users", "id").onDelete("CASCADE"),
        },
      },
    })
    const ddl = db.generateDDL()
    expect(ddl[0]!.sql).toContain("ON DELETE CASCADE")
  })

  it("generates string DEFAULT", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: {
        config: {
          id: serial().primaryKey(),
          locale: varchar(10).defaultTo("en"),
        },
      },
    })
    const ddl = db.generateDDL()
    expect(ddl[0]!.sql).toContain("DEFAULT 'en'")
  })
})
