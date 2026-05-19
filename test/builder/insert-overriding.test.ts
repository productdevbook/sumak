import { describe, expect, it } from "vitest"

import { col, star } from "../../src/ast/expression.ts"
import { InsertBuilder, insert } from "../../src/builder/insert.ts"
import { SelectBuilder } from "../../src/builder/select.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { MssqlPrinter } from "../../src/printer/mssql.ts"
import { MysqlPrinter } from "../../src/printer/mysql.ts"
import { PgPrinter } from "../../src/printer/pg.ts"
import { SqlitePrinter } from "../../src/printer/sqlite.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const pg = new PgPrinter()
const mysql = new MysqlPrinter()
const sqlite = new SqlitePrinter()
const mssql = new MssqlPrinter()

describe("INSERT OVERRIDING { SYSTEM | USER } VALUE — AST + builder", () => {
  it("untyped builder sets overriding = 'SYSTEM'", () => {
    const node = insert("orders")
      .columns("id", "customer_id")
      .values(1, 42)
      .overridingSystemValue()
      .build()
    expect(node.overriding).toBe("SYSTEM")
  })

  it("untyped builder sets overriding = 'USER'", () => {
    const node = insert("orders")
      .columns("id", "customer_id")
      .values(99, 42)
      .overridingUserValue()
      .build()
    expect(node.overriding).toBe("USER")
  })

  it("last call wins — overridingUserValue() overrides overridingSystemValue()", () => {
    const node = insert("orders")
      .columns("id")
      .values(1)
      .overridingSystemValue()
      .overridingUserValue()
      .build()
    expect(node.overriding).toBe("USER")
  })

  it("builder is immutable — does not mutate the original", () => {
    const base = insert("orders").columns("id").values(1)
    const sys = base.overridingSystemValue()
    const user = base.overridingUserValue()
    expect(base.build().overriding).toBeUndefined()
    expect(sys.build().overriding).toBe("SYSTEM")
    expect(user.build().overriding).toBe("USER")
  })
})

describe("INSERT OVERRIDING SYSTEM VALUE — PG printer", () => {
  it("emits OVERRIDING SYSTEM VALUE between column list and VALUES", () => {
    const node = insert("orders")
      .columns("id", "customer_id")
      .values(1, 42)
      .overridingSystemValue()
      .build()
    const result = pg.print(node)
    expect(result.sql).toBe(
      'INSERT INTO "orders" ("id", "customer_id") OVERRIDING SYSTEM VALUE VALUES ($1, $2)',
    )
    expect(result.params).toEqual([1, 42])
  })

  it("emits OVERRIDING USER VALUE between column list and VALUES", () => {
    const node = insert("orders")
      .columns("id", "customer_id")
      .values(99, 42)
      .overridingUserValue()
      .build()
    const result = pg.print(node)
    expect(result.sql).toBe(
      'INSERT INTO "orders" ("id", "customer_id") OVERRIDING USER VALUE VALUES ($1, $2)',
    )
    expect(result.params).toEqual([99, 42])
  })

  it("combines with RETURNING", () => {
    const node = insert("orders")
      .columns("id", "customer_id")
      .values(1, 42)
      .overridingSystemValue()
      .returning(star())
      .build()
    const result = pg.print(node)
    expect(result.sql).toContain("OVERRIDING SYSTEM VALUE")
    expect(result.sql).toContain("RETURNING *")
    // OVERRIDING appears before VALUES; RETURNING appears after.
    expect(result.sql.indexOf("OVERRIDING")).toBeLessThan(result.sql.indexOf("VALUES"))
    expect(result.sql.indexOf("VALUES")).toBeLessThan(result.sql.indexOf("RETURNING"))
  })

  it("combines with INSERT ... SELECT", () => {
    const select = new SelectBuilder().columns("id", "customer_id").from("temp_orders").build()
    const node = insert("orders")
      .columns("id", "customer_id")
      .overridingSystemValue()
      .fromSelect(select)
      .build()
    const result = pg.print(node)
    // OVERRIDING sits between the column list and the SELECT source.
    expect(result.sql).toMatch(
      /INSERT INTO "orders" \("id", "customer_id"\) OVERRIDING SYSTEM VALUE SELECT/,
    )
  })

  it("combines with ON CONFLICT DO UPDATE", () => {
    const node = insert("orders")
      .columns("id", "customer_id")
      .values(1, 42)
      .overridingSystemValue()
      .onConflictDoUpdate(["id"], [{ column: "customer_id", value: col("EXCLUDED.customer_id") }])
      .build()
    const result = pg.print(node)
    expect(result.sql).toContain("OVERRIDING SYSTEM VALUE")
    expect(result.sql).toContain("ON CONFLICT")
    expect(result.sql).toContain("DO UPDATE SET")
  })

  it("typed builder on PG emits OVERRIDING SYSTEM VALUE", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: {
        orders: { id: serial().primaryKey(), customerId: integer().notNull() },
      },
    })
    const q = db
      .insertInto("orders")
      .values({ id: 1, customerId: 42 })
      .overridingSystemValue()
      .compile(db.printer())
    expect(q.sql).toContain("OVERRIDING SYSTEM VALUE")
  })

  it("typed builder on PG emits OVERRIDING USER VALUE", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: {
        orders: { id: serial().primaryKey(), customerId: integer().notNull() },
      },
    })
    const q = db
      .insertInto("orders")
      .values({ id: 99, customerId: 42 })
      .overridingUserValue()
      .compile(db.printer())
    expect(q.sql).toContain("OVERRIDING USER VALUE")
  })

  it("no overriding clause = no OVERRIDING in SQL", () => {
    const node = insert("orders").columns("id").values(1).build()
    const result = pg.print(node)
    expect(result.sql).not.toContain("OVERRIDING")
  })
})

describe("INSERT OVERRIDING — non-PG dialects reject", () => {
  it("MSSQL throws UnsupportedDialectFeatureError on OVERRIDING SYSTEM VALUE", () => {
    const node = new InsertBuilder()
      .into("orders")
      .columns("id", "customer_id")
      .values(1, 42)
      .overridingSystemValue()
      .build()
    expect(() => mssql.print(node)).toThrow(UnsupportedDialectFeatureError)
    expect(() => mssql.print(node)).toThrow(/OVERRIDING SYSTEM\/USER VALUE/)
  })

  it("MSSQL throws on OVERRIDING USER VALUE", () => {
    const node = new InsertBuilder()
      .into("orders")
      .columns("id")
      .values(99)
      .overridingUserValue()
      .build()
    expect(() => mssql.print(node)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MySQL throws UnsupportedDialectFeatureError on OVERRIDING SYSTEM VALUE", () => {
    const node = new InsertBuilder()
      .into("orders")
      .columns("id", "customer_id")
      .values(1, 42)
      .overridingSystemValue()
      .build()
    expect(() => mysql.print(node)).toThrow(UnsupportedDialectFeatureError)
    expect(() => mysql.print(node)).toThrow(/OVERRIDING SYSTEM\/USER VALUE/)
  })

  it("SQLite throws UnsupportedDialectFeatureError on OVERRIDING SYSTEM VALUE", () => {
    const node = new InsertBuilder()
      .into("orders")
      .columns("id", "customer_id")
      .values(1, 42)
      .overridingSystemValue()
      .build()
    expect(() => sqlite.print(node)).toThrow(UnsupportedDialectFeatureError)
    expect(() => sqlite.print(node)).toThrow(/OVERRIDING SYSTEM\/USER VALUE/)
  })

  it("typed builders on non-PG dialects all reject", () => {
    for (const dialect of [
      { name: "mysql", make: mysqlDialect },
      { name: "sqlite", make: sqliteDialect },
      { name: "mssql", make: mssqlDialect },
    ] as const) {
      const db = sumak({
        dialect: dialect.make(),
        tables: { orders: { id: serial().primaryKey(), customerId: integer().notNull() } },
      })
      expect(() =>
        db
          .insertInto("orders")
          .values({ id: 1, customerId: 42 })
          .overridingSystemValue()
          .compile(db.printer()),
      ).toThrow(UnsupportedDialectFeatureError)
    }
  })
})

describe("INSERT OVERRIDING — schema column reference in test (unused but documents intent)", () => {
  // Keep `text()` import live so this file makes its imports useful.
  it("schema-aware tables compile through the typed surface", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: {
        orders: {
          id: serial().primaryKey(),
          customerId: integer().notNull(),
          note: text(),
        },
      },
    })
    const q = db
      .insertInto("orders")
      .values({ id: 1, customerId: 42, note: "manual" })
      .overridingSystemValue()
      .compile(db.printer())
    expect(q.sql).toContain("OVERRIDING SYSTEM VALUE")
  })
})
