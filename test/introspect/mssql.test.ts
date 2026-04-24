import { describe, expect, it } from "vitest"

import type { Driver } from "../../src/driver/types.ts"
import { introspectMssql } from "../../src/introspect/mssql.ts"

function mockDriver(byMatch: Array<{ matches: (sql: string) => boolean; rows: unknown[] }>): {
  driver: Driver
} {
  const driver: Driver = {
    async query(sql: string) {
      for (const r of byMatch) {
        if (r.matches(sql)) return r.rows as Record<string, unknown>[]
      }
      return []
    },
    async execute() {
      return { affected: 0 }
    },
  }
  return { driver }
}

describe("introspectMssql — constraints + indexes", () => {
  it("reconstructs a composite PK", async () => {
    const { driver } = mockDriver([
      {
        matches: (s) => /FROM INFORMATION_SCHEMA\.TABLES/i.test(s),
        rows: [{ TABLE_NAME: "order_items" }],
      },
      {
        matches: (s) => /FROM INFORMATION_SCHEMA\.COLUMNS/i.test(s),
        rows: [
          {
            TABLE_NAME: "order_items",
            COLUMN_NAME: "order_id",
            IS_NULLABLE: "NO",
            DATA_TYPE: "int",
            COLUMN_DEFAULT: null,
            is_identity: 0,
          },
          {
            TABLE_NAME: "order_items",
            COLUMN_NAME: "sku",
            IS_NULLABLE: "NO",
            DATA_TYPE: "varchar",
            COLUMN_DEFAULT: null,
            is_identity: 0,
          },
        ],
      },
      {
        matches: (s) =>
          /FROM INFORMATION_SCHEMA\.TABLE_CONSTRAINTS/i.test(s) && /IN \('PRIMARY KEY'/i.test(s),
        rows: [
          {
            TABLE_NAME: "order_items",
            CONSTRAINT_NAME: "pk_order_items",
            CONSTRAINT_TYPE: "PRIMARY KEY",
            COLUMN_NAME: "order_id",
            ORDINAL_POSITION: 1,
          },
          {
            TABLE_NAME: "order_items",
            CONSTRAINT_NAME: "pk_order_items",
            CONSTRAINT_TYPE: "PRIMARY KEY",
            COLUMN_NAME: "sku",
            ORDINAL_POSITION: 2,
          },
        ],
      },
      { matches: (s) => /FROM sys\.check_constraints/i.test(s), rows: [] },
      { matches: (s) => /FROM sys\.foreign_keys/i.test(s), rows: [] },
      { matches: (s) => /FROM sys\.indexes/i.test(s), rows: [] },
    ])

    const schema = await introspectMssql(driver)
    const t = schema.tables[0]!
    expect([...(t.constraints?.primaryKey?.columns ?? [])]).toEqual(["order_id", "sku"])
    expect(t.constraints?.primaryKey?.name).toBe("pk_order_items")
  })

  it("reads CHECK with double-wrapped parens stripped", async () => {
    const { driver } = mockDriver([
      {
        matches: (s) => /FROM INFORMATION_SCHEMA\.TABLES/i.test(s),
        rows: [{ TABLE_NAME: "products" }],
      },
      {
        matches: (s) => /FROM INFORMATION_SCHEMA\.COLUMNS/i.test(s),
        rows: [
          {
            TABLE_NAME: "products",
            COLUMN_NAME: "price",
            IS_NULLABLE: "NO",
            DATA_TYPE: "int",
            COLUMN_DEFAULT: null,
            is_identity: 0,
          },
        ],
      },
      { matches: (s) => /FROM INFORMATION_SCHEMA\.TABLE_CONSTRAINTS/i.test(s), rows: [] },
      {
        matches: (s) => /FROM sys\.check_constraints/i.test(s),
        rows: [
          {
            table_name: "products",
            constraint_name: "ck_price_pos",
            // MSSQL wraps the definition with extra parens; the
            // introspector strips up to two balanced outer layers.
            def: "((price>(0)))",
          },
        ],
      },
      { matches: (s) => /FROM sys\.foreign_keys/i.test(s), rows: [] },
      { matches: (s) => /FROM sys\.indexes/i.test(s), rows: [] },
    ])

    const schema = await introspectMssql(driver)
    const t = schema.tables[0]!
    const c = t.constraints?.checks?.[0]
    expect(c?.name).toBe("ck_price_pos")
    expect(c?.expression).toBe("price>(0)")
  })

  it("reads a named non-clustered index with a filter", async () => {
    const { driver } = mockDriver([
      {
        matches: (s) => /FROM INFORMATION_SCHEMA\.TABLES/i.test(s),
        rows: [{ TABLE_NAME: "posts" }],
      },
      {
        matches: (s) => /FROM INFORMATION_SCHEMA\.COLUMNS/i.test(s),
        rows: [
          {
            TABLE_NAME: "posts",
            COLUMN_NAME: "title",
            IS_NULLABLE: "NO",
            DATA_TYPE: "nvarchar",
            COLUMN_DEFAULT: null,
            is_identity: 0,
          },
          {
            TABLE_NAME: "posts",
            COLUMN_NAME: "deletedAt",
            IS_NULLABLE: "YES",
            DATA_TYPE: "datetime2",
            COLUMN_DEFAULT: null,
            is_identity: 0,
          },
        ],
      },
      { matches: (s) => /FROM INFORMATION_SCHEMA\.TABLE_CONSTRAINTS/i.test(s), rows: [] },
      { matches: (s) => /FROM sys\.check_constraints/i.test(s), rows: [] },
      { matches: (s) => /FROM sys\.foreign_keys/i.test(s), rows: [] },
      {
        matches: (s) => /FROM sys\.indexes/i.test(s),
        rows: [
          {
            table_name: "posts",
            index_name: "ix_posts_title_active",
            is_unique: true,
            type_desc: "NONCLUSTERED",
            has_filter: true,
            filter_definition: "([deletedAt] IS NULL)",
            column_name: "title",
            key_ordinal: 1,
          },
        ],
      },
    ])

    const schema = await introspectMssql(driver)
    const t = schema.tables[0]!
    const idx = t.indexes?.[0]
    expect(idx?.name).toBe("ix_posts_title_active")
    expect(idx?.unique).toBe(true)
    expect(idx?.where).toBe("[deletedAt] IS NULL")
  })

  it("groups a composite FK under constraints.foreignKeys", async () => {
    const { driver } = mockDriver([
      {
        matches: (s) => /FROM INFORMATION_SCHEMA\.TABLES/i.test(s),
        rows: [{ TABLE_NAME: "line_items" }],
      },
      {
        matches: (s) => /FROM INFORMATION_SCHEMA\.COLUMNS/i.test(s),
        rows: [
          {
            TABLE_NAME: "line_items",
            COLUMN_NAME: "order_id",
            IS_NULLABLE: "NO",
            DATA_TYPE: "int",
            COLUMN_DEFAULT: null,
            is_identity: 0,
          },
          {
            TABLE_NAME: "line_items",
            COLUMN_NAME: "sku",
            IS_NULLABLE: "NO",
            DATA_TYPE: "varchar",
            COLUMN_DEFAULT: null,
            is_identity: 0,
          },
        ],
      },
      { matches: (s) => /FROM INFORMATION_SCHEMA\.TABLE_CONSTRAINTS/i.test(s), rows: [] },
      { matches: (s) => /FROM sys\.check_constraints/i.test(s), rows: [] },
      {
        matches: (s) => /FROM sys\.foreign_keys/i.test(s),
        rows: [
          {
            from_table: "line_items",
            constraint_name: "fk_line_order_sku",
            from_column: "order_id",
            position: 1,
            to_table: "orders",
            to_column: "order_id",
            on_delete: "CASCADE",
            on_update: "NO_ACTION",
          },
          {
            from_table: "line_items",
            constraint_name: "fk_line_order_sku",
            from_column: "sku",
            position: 2,
            to_table: "orders",
            to_column: "sku",
            on_delete: "CASCADE",
            on_update: "NO_ACTION",
          },
        ],
      },
      { matches: (s) => /FROM sys\.indexes/i.test(s), rows: [] },
    ])

    const schema = await introspectMssql(driver)
    const t = schema.tables[0]!
    const fk = t.constraints?.foreignKeys?.[0]
    expect(fk?.name).toBe("fk_line_order_sku")
    expect([...(fk?.columns ?? [])]).toEqual(["order_id", "sku"])
    expect([...(fk?.references.columns ?? [])]).toEqual(["order_id", "sku"])
    expect(fk?.onDelete).toBe("CASCADE")
  })
})
