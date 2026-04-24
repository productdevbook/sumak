import { describe, expect, it } from "vitest"

import type { Driver } from "../../src/driver/types.ts"
import { introspectMysql } from "../../src/introspect/mysql.ts"

/**
 * Minimal mock driver: dispatch canned rows based on a SQL prefix so
 * the introspector's query sequence can be simulated without booting
 * an actual MySQL. Each test wires up just the rowsets it needs for
 * the feature under test.
 */
function mockDriver(byMatch: Array<{ matches: (sql: string) => boolean; rows: unknown[] }>): {
  driver: Driver
  queries: string[]
} {
  const queries: string[] = []
  const driver: Driver = {
    async query(sql: string) {
      queries.push(sql)
      for (const r of byMatch) {
        if (r.matches(sql)) return r.rows as Record<string, unknown>[]
      }
      return []
    },
    async execute() {
      return { affected: 0 }
    },
  }
  return { driver, queries }
}

describe("introspectMysql — constraints + indexes", () => {
  it("reconstructs a composite PK from table_constraints + key_column_usage", async () => {
    const { driver } = mockDriver([
      {
        matches: (s) => /FROM information_schema\.tables/i.test(s),
        rows: [{ table_name: "order_items" }],
      },
      {
        matches: (s) => /FROM information_schema\.columns/i.test(s),
        rows: [
          {
            table_name: "order_items",
            column_name: "order_id",
            is_nullable: "NO",
            data_type: "int",
            column_type: "int(11)",
            column_default: null,
            column_key: "PRI",
            extra: "",
          },
          {
            table_name: "order_items",
            column_name: "sku",
            is_nullable: "NO",
            data_type: "varchar",
            column_type: "varchar(64)",
            column_default: null,
            column_key: "PRI",
            extra: "",
          },
        ],
      },
      {
        matches: (s) =>
          /FROM information_schema\.key_column_usage/i.test(s) && /referenced/i.test(s),
        rows: [],
      },
      {
        matches: (s) => /FROM information_schema\.table_constraints/i.test(s),
        rows: [
          {
            table_name: "order_items",
            constraint_name: "PRIMARY",
            constraint_type: "PRIMARY KEY",
            column_name: "order_id",
            ordinal_position: 1,
          },
          {
            table_name: "order_items",
            constraint_name: "PRIMARY",
            constraint_type: "PRIMARY KEY",
            column_name: "sku",
            ordinal_position: 2,
          },
        ],
      },
      {
        matches: (s) => /FROM information_schema\.check_constraints/i.test(s),
        rows: [],
      },
      {
        matches: (s) => /FROM information_schema\.statistics/i.test(s),
        rows: [],
      },
    ])

    const schema = await introspectMysql(driver)
    const t = schema.tables[0]!
    expect(t.name).toBe("order_items")
    expect([...(t.constraints?.primaryKey?.columns ?? [])]).toEqual(["order_id", "sku"])
  })

  it("reads a named composite UNIQUE", async () => {
    const { driver } = mockDriver([
      {
        matches: (s) => /FROM information_schema\.tables/i.test(s),
        rows: [{ table_name: "members" }],
      },
      {
        matches: (s) => /FROM information_schema\.columns/i.test(s),
        rows: [
          {
            table_name: "members",
            column_name: "org_id",
            is_nullable: "NO",
            data_type: "int",
            column_type: "int",
            column_default: null,
            column_key: "MUL",
            extra: "",
          },
          {
            table_name: "members",
            column_name: "user_id",
            is_nullable: "NO",
            data_type: "int",
            column_type: "int",
            column_default: null,
            column_key: "",
            extra: "",
          },
        ],
      },
      {
        matches: (s) =>
          /FROM information_schema\.key_column_usage/i.test(s) && /referenced/i.test(s),
        rows: [],
      },
      {
        matches: (s) => /FROM information_schema\.table_constraints/i.test(s),
        rows: [
          {
            table_name: "members",
            constraint_name: "uq_org_user",
            constraint_type: "UNIQUE",
            column_name: "org_id",
            ordinal_position: 1,
          },
          {
            table_name: "members",
            constraint_name: "uq_org_user",
            constraint_type: "UNIQUE",
            column_name: "user_id",
            ordinal_position: 2,
          },
        ],
      },
      { matches: (s) => /FROM information_schema\.check_constraints/i.test(s), rows: [] },
      { matches: (s) => /FROM information_schema\.statistics/i.test(s), rows: [] },
    ])

    const schema = await introspectMysql(driver)
    const t = schema.tables[0]!
    expect(t.constraints?.uniques?.[0]?.name).toBe("uq_org_user")
    expect([...(t.constraints?.uniques?.[0]?.columns ?? [])]).toEqual(["org_id", "user_id"])
  })

  it("reads CHECK with body and strips outer parens", async () => {
    const { driver } = mockDriver([
      {
        matches: (s) => /FROM information_schema\.tables/i.test(s),
        rows: [{ table_name: "products" }],
      },
      {
        matches: (s) => /FROM information_schema\.columns/i.test(s),
        rows: [
          {
            table_name: "products",
            column_name: "price",
            is_nullable: "NO",
            data_type: "int",
            column_type: "int",
            column_default: null,
            column_key: "",
            extra: "",
          },
        ],
      },
      {
        matches: (s) =>
          /FROM information_schema\.key_column_usage/i.test(s) && /referenced/i.test(s),
        rows: [],
      },
      { matches: (s) => /FROM information_schema\.table_constraints/i.test(s), rows: [] },
      {
        matches: (s) => /FROM information_schema\.check_constraints/i.test(s),
        rows: [
          {
            constraint_name: "ck_price_pos",
            check_clause: "(price > 0)",
            table_name: "products",
          },
        ],
      },
      { matches: (s) => /FROM information_schema\.statistics/i.test(s), rows: [] },
    ])

    const schema = await introspectMysql(driver)
    const t = schema.tables[0]!
    const c = t.constraints?.checks?.[0]
    expect(c?.name).toBe("ck_price_pos")
    expect(c?.expression).toBe("price > 0")
  })

  it("reads a named index (non-unique) and skips UNIQUE-constraint-backed ones", async () => {
    const { driver } = mockDriver([
      {
        matches: (s) => /FROM information_schema\.tables/i.test(s),
        rows: [{ table_name: "posts" }],
      },
      {
        matches: (s) => /FROM information_schema\.columns/i.test(s),
        rows: [
          {
            table_name: "posts",
            column_name: "slug",
            is_nullable: "NO",
            data_type: "varchar",
            column_type: "varchar(64)",
            column_default: null,
            column_key: "UNI",
            extra: "",
          },
          {
            table_name: "posts",
            column_name: "category",
            is_nullable: "YES",
            data_type: "varchar",
            column_type: "varchar(64)",
            column_default: null,
            column_key: "MUL",
            extra: "",
          },
        ],
      },
      {
        matches: (s) =>
          /FROM information_schema\.key_column_usage/i.test(s) && /referenced/i.test(s),
        rows: [],
      },
      {
        matches: (s) => /FROM information_schema\.table_constraints/i.test(s),
        rows: [
          {
            table_name: "posts",
            constraint_name: "uq_posts_slug",
            constraint_type: "UNIQUE",
            column_name: "slug",
            ordinal_position: 1,
          },
        ],
      },
      { matches: (s) => /FROM information_schema\.check_constraints/i.test(s), rows: [] },
      {
        matches: (s) => /FROM information_schema\.statistics/i.test(s),
        rows: [
          // The uq_posts_slug index — must be filtered out.
          {
            table_name: "posts",
            index_name: "uq_posts_slug",
            column_name: "slug",
            seq_in_index: 1,
            non_unique: 0,
            index_type: "BTREE",
          },
          {
            table_name: "posts",
            index_name: "ix_posts_category",
            column_name: "category",
            seq_in_index: 1,
            non_unique: 1,
            index_type: "BTREE",
          },
        ],
      },
    ])

    const schema = await introspectMysql(driver)
    const t = schema.tables[0]!
    expect(t.indexes?.length).toBe(1)
    expect(t.indexes?.[0]?.name).toBe("ix_posts_category")
    expect(t.indexes?.[0]?.unique).toBe(false)
  })

  it("groups a composite FK under constraints.foreignKeys", async () => {
    const { driver } = mockDriver([
      {
        matches: (s) => /FROM information_schema\.tables/i.test(s),
        rows: [{ table_name: "line_items" }],
      },
      {
        matches: (s) => /FROM information_schema\.columns/i.test(s),
        rows: [
          {
            table_name: "line_items",
            column_name: "order_id",
            is_nullable: "NO",
            data_type: "int",
            column_type: "int",
            column_default: null,
            column_key: "MUL",
            extra: "",
          },
          {
            table_name: "line_items",
            column_name: "sku",
            is_nullable: "NO",
            data_type: "varchar",
            column_type: "varchar(64)",
            column_default: null,
            column_key: "MUL",
            extra: "",
          },
        ],
      },
      {
        matches: (s) =>
          /FROM information_schema\.key_column_usage/i.test(s) && /referenced/i.test(s),
        rows: [
          {
            from_table: "line_items",
            from_column: "order_id",
            constraint_name: "fk_line_order_sku",
            ordinal_position: 1,
            to_table: "orders",
            to_column: "order_id",
            on_delete: "CASCADE",
            on_update: "RESTRICT",
          },
          {
            from_table: "line_items",
            from_column: "sku",
            constraint_name: "fk_line_order_sku",
            ordinal_position: 2,
            to_table: "orders",
            to_column: "sku",
            on_delete: "CASCADE",
            on_update: "RESTRICT",
          },
        ],
      },
      { matches: (s) => /FROM information_schema\.table_constraints/i.test(s), rows: [] },
      { matches: (s) => /FROM information_schema\.check_constraints/i.test(s), rows: [] },
      { matches: (s) => /FROM information_schema\.statistics/i.test(s), rows: [] },
    ])

    const schema = await introspectMysql(driver)
    const t = schema.tables[0]!
    const fk = t.constraints?.foreignKeys?.[0]
    expect(fk).toBeDefined()
    expect(fk!.name).toBe("fk_line_order_sku")
    expect([...fk!.columns]).toEqual(["order_id", "sku"])
    expect([...fk!.references.columns]).toEqual(["order_id", "sku"])
    expect(fk!.onDelete).toBe("CASCADE")
  })

  it("swallows a missing check_constraints view (MySQL < 8.0.16)", async () => {
    const driver: Driver = {
      async query(sql: string) {
        if (/FROM information_schema\.tables/i.test(sql)) return [{ table_name: "t" }]
        if (/FROM information_schema\.columns/i.test(sql))
          return [
            {
              table_name: "t",
              column_name: "id",
              is_nullable: "NO",
              data_type: "int",
              column_type: "int",
              column_default: null,
              column_key: "PRI",
              extra: "auto_increment",
            },
          ]
        if (/FROM information_schema\.check_constraints/i.test(sql)) {
          throw new Error("1146: Table 'information_schema.check_constraints' doesn't exist")
        }
        return []
      },
      async execute() {
        return { affected: 0 }
      },
    }

    const schema = await introspectMysql(driver)
    // Older MySQL/MariaDB — the missing view shouldn't kill the whole
    // introspection. We still get the table + column.
    expect(schema.tables).toHaveLength(1)
    expect(schema.tables[0]!.columns[0]!.dataType).toBe("serial")
  })
})
