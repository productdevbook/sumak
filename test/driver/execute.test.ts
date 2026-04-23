import { describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { MissingDriverError, UnexpectedRowCountError } from "../../src/driver/execute.ts"
import type { Driver } from "../../src/driver/types.ts"
import { integer, serial, text } from "../../src/schema/index.ts"
import { sumak } from "../../src/sumak.ts"

// ── Fake driver ───────────────────────────────────────────────────
// Records every (sql, params) pair and returns canned rows. No real
// database — tests focus on the builder → driver contract.

function fakeDriver(rows: Record<string, unknown>[] = []): Driver & {
  calls: { kind: "query" | "execute"; sql: string; params: readonly unknown[] }[]
} {
  const calls: { kind: "query" | "execute"; sql: string; params: readonly unknown[] }[] = []
  return {
    calls,
    async query(sql, params) {
      calls.push({ kind: "query", sql, params })
      return rows
    },
    async execute(sql, params) {
      calls.push({ kind: "execute", sql, params })
      return { affected: rows.length || 1 }
    },
  }
}

const TABLES = {
  users: {
    id: serial().primaryKey(),
    name: text().notNull(),
    age: integer().nullable(),
  },
}

describe("driver adapter", () => {
  describe("without a driver", () => {
    it("builder methods work; .many/.one/.first/.exec throw MissingDriverError", async () => {
      const db = sumak({ dialect: pgDialect(), tables: TABLES })
      // Building + SQL still works — no driver needed for that.
      expect(db.selectFrom("users").toSQL().sql).toContain(`FROM "users"`)

      await expect(db.selectFrom("users").many()).rejects.toBeInstanceOf(MissingDriverError)
      await expect(
        db
          .selectFrom("users")
          .where(({ id }) => id.eq(1))
          .one(),
      ).rejects.toBeInstanceOf(MissingDriverError)
      await expect(
        db
          .deleteFrom("users")
          .where(({ id }) => id.eq(1))
          .exec(),
      ).rejects.toBeInstanceOf(MissingDriverError)
    })
  })

  describe("SELECT", () => {
    it(".many() returns all rows", async () => {
      const driver = fakeDriver([
        { id: 1, name: "Alice", age: 30 },
        { id: 2, name: "Bob", age: 25 },
      ])
      const db = sumak({ dialect: pgDialect(), driver, tables: TABLES })

      const users = await db.selectFrom("users").selectAll().many()
      expect(users).toHaveLength(2)
      expect(users[0]!.name).toBe("Alice")
      expect(driver.calls).toHaveLength(1)
      expect(driver.calls[0]!.kind).toBe("query")
      expect(driver.calls[0]!.sql).toContain(`FROM "users"`)
    })

    it(".one() returns the single row", async () => {
      const driver = fakeDriver([{ id: 1, name: "Alice" }])
      const db = sumak({ dialect: pgDialect(), driver, tables: TABLES })

      const u = await db
        .selectFrom("users")
        .where(({ id }) => id.eq(1))
        .one()
      expect(u.name).toBe("Alice")
      // Params for WHERE + LIMIT 1 literal — placeholder style is pg $1.
      expect(driver.calls[0]!.params).toEqual([1])
    })

    it(".one() throws UnexpectedRowCountError on 0 rows", async () => {
      const driver = fakeDriver([])
      const db = sumak({ dialect: pgDialect(), driver, tables: TABLES })

      await expect(
        db
          .selectFrom("users")
          .where(({ id }) => id.eq(99))
          .one(),
      ).rejects.toBeInstanceOf(UnexpectedRowCountError)
    })

    it(".one() throws UnexpectedRowCountError on >1 rows", async () => {
      const driver = fakeDriver([
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ])
      const db = sumak({ dialect: pgDialect(), driver, tables: TABLES })

      await expect(db.selectFrom("users").one()).rejects.toBeInstanceOf(UnexpectedRowCountError)
    })

    it(".first() returns the first row or null", async () => {
      const db1 = sumak({
        dialect: pgDialect(),
        driver: fakeDriver([{ id: 1, name: "Alice" }]),
        tables: TABLES,
      })
      const db2 = sumak({ dialect: pgDialect(), driver: fakeDriver([]), tables: TABLES })

      expect((await db1.selectFrom("users").first())?.id).toBe(1)
      expect(await db2.selectFrom("users").first()).toBeNull()
    })
  })

  describe("INSERT / UPDATE / DELETE", () => {
    it(".exec() on INSERT fires driver.execute", async () => {
      const driver = fakeDriver()
      const db = sumak({ dialect: pgDialect(), driver, tables: TABLES })

      const r = await db.insertInto("users").values({ name: "Alice" }).exec()
      expect(r.affected).toBe(1)
      expect(driver.calls[0]!.kind).toBe("execute")
      expect(driver.calls[0]!.sql).toContain(`INSERT INTO "users"`)
    })

    it("INSERT … RETURNING uses .many() → driver.query", async () => {
      const driver = fakeDriver([{ id: 42, name: "Alice" }])
      const db = sumak({ dialect: pgDialect(), driver, tables: TABLES })

      const rows = await db.insertInto("users").values({ name: "Alice" }).returning("id").many()
      expect(rows).toEqual([{ id: 42, name: "Alice" }])
      expect(driver.calls[0]!.kind).toBe("query")
      expect(driver.calls[0]!.sql).toContain("RETURNING")
    })

    it("UPDATE … RETURNING .one() returns single row", async () => {
      const driver = fakeDriver([{ id: 1, name: "Bob" }])
      const db = sumak({ dialect: pgDialect(), driver, tables: TABLES })

      const row = await db
        .update("users")
        .set({ name: "Bob" })
        .where(({ id }) => id.eq(1))
        .returningAll()
        .one()
      expect(row.name).toBe("Bob")
    })

    it("DELETE .exec() fires driver.execute + { affected }", async () => {
      const driver = fakeDriver([{}])
      const db = sumak({ dialect: pgDialect(), driver, tables: TABLES })

      const r = await db
        .deleteFrom("users")
        .where(({ id }) => id.eq(1))
        .exec()
      expect(r.affected).toBe(1)
    })
  })

  describe("result transforms", () => {
    it("result:transform hooks fire between driver.query and caller", async () => {
      const driver = fakeDriver([{ id: 1, name: "alice" }])
      const db = sumak({ dialect: pgDialect(), driver, tables: TABLES })
      db.hook("result:transform", (rows) =>
        rows.map((r) => ({ ...r, name: String((r as { name: unknown }).name).toUpperCase() })),
      )

      const rows = await db.selectFrom("users").many()
      expect((rows[0] as { name: string }).name).toBe("ALICE")
    })
  })

  describe("Sumak.executeCompiled / executeCompiledNoRows", () => {
    it("executeCompiled runs compiled query through the driver + transforms", async () => {
      const driver = fakeDriver([{ id: 7 }])
      const db = sumak({ dialect: pgDialect(), driver, tables: TABLES })

      const compiled = db.selectFrom("users").select("id").toSQL()
      const rows = await db.executeCompiled(compiled)
      expect(rows).toEqual([{ id: 7 }])
    })

    it("executeCompiledNoRows uses driver.execute", async () => {
      const driver = fakeDriver()
      const db = sumak({ dialect: pgDialect(), driver, tables: TABLES })

      const r = await db.executeCompiledNoRows({ sql: "SELECT 1", params: [] })
      expect(r.affected).toBe(1)
      expect(driver.calls[0]!.kind).toBe("execute")
    })
  })
})
