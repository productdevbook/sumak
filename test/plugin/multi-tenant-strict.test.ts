import { describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { CrossTenantJoinError } from "../../src/errors.ts"
import { multiTenant } from "../../src/plugin/factories.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

// multiTenant({ strict: true }) makes JOIN coverage an explicit check:
// a JOIN to a table outside the tenant-aware allow-list either gets
// rejected at compile time (CrossTenantJoinError) or must be marked
// with `.crossTenant({ reason })` as a deliberate escape hatch. This
// closes the long-standing silent-leak hole in the non-strict path.

function build(strict: boolean) {
  return sumak({
    dialect: pgDialect(),
    plugins: [
      multiTenant({
        tables: ["orders"],
        tenantId: () => 1,
        strict,
      }),
    ],
    tables: {
      orders: {
        id: serial().primaryKey(),
        tenant_id: integer().notNull(),
        customer_name: text().notNull(),
        currency: text().notNull(),
      },
      currency_rates: {
        code: text().primaryKey(),
        rate: integer().notNull(),
      },
      order_lines: {
        id: serial().primaryKey(),
        order_id: integer().notNull(),
        tenant_id: integer().notNull(),
        qty: integer().notNull(),
      },
    },
  })
}

describe("multiTenant strict-mode JOIN allow-list", () => {
  it("strict: false — JOIN to a non-tenant-aware table passes silently (legacy)", () => {
    const db = build(false)
    const { sql } = db
      .selectFrom("orders")
      .innerJoin("currency_rates", ({ orders, currency_rates }) =>
        orders.currency.eq(currency_rates.code),
      )
      .selectAll()
      .toSQL()
    // Main-table filter is there, but the join has no tenant guard.
    expect(sql).toMatch(/tenant_id/)
  })

  it("strict: true — rejects a JOIN to a table that isn't in the allow-list", () => {
    const db = build(true)
    expect(() =>
      db
        .selectFrom("orders")
        .innerJoin("currency_rates", ({ orders, currency_rates }) =>
          orders.currency.eq(currency_rates.code),
        )
        .selectAll()
        .toSQL(),
    ).toThrow(CrossTenantJoinError)
  })

  it("strict: true — injects tenant_id = ? on JOINs to tenant-aware tables", () => {
    // order_lines is tenant-aware. The plugin should add
    // `order_lines.tenant_id = ?` to the join's ON clause.
    const db = sumak({
      dialect: pgDialect(),
      plugins: [
        multiTenant({ tables: ["orders", "order_lines"], tenantId: () => 1, strict: true }),
      ],
      tables: build(false)._schema
        ? (build(false)._schema as unknown as Record<
            string,
            Record<string, import("../../src/schema/column.ts").ColumnBuilder<any, any, any>>
          >)
        : {},
    })
    // Fresh schema to keep the test self-contained:
    const db2 = sumak({
      dialect: pgDialect(),
      plugins: [
        multiTenant({ tables: ["orders", "order_lines"], tenantId: () => 7, strict: true }),
      ],
      tables: {
        orders: {
          id: serial().primaryKey(),
          tenant_id: integer().notNull(),
        },
        order_lines: {
          id: serial().primaryKey(),
          order_id: integer().notNull(),
          tenant_id: integer().notNull(),
          qty: integer().notNull(),
        },
      },
    })
    const { sql } = db2
      .selectFrom("orders")
      .innerJoin("order_lines", ({ orders, order_lines }) => orders.id.eq(order_lines.order_id))
      .selectAll()
      .toSQL()
    // Both the main filter and the join guard should be present.
    expect(sql.match(/tenant_id/g)).not.toBeNull()
    // Two occurrences — main WHERE and JOIN ON.
    expect(sql.match(/tenant_id/g)!.length).toBeGreaterThanOrEqual(2)
    void db // silence unused
  })

  it("strict: true — .crossTenant({ reason }) opts the query out of the allow-list check", () => {
    const db = build(true)
    expect(() =>
      db
        .selectFrom("orders")
        .innerJoin("currency_rates", ({ orders, currency_rates }) =>
          orders.currency.eq(currency_rates.code),
        )
        .crossTenant({ reason: "currency_rates is shared reference data" })
        .selectAll()
        .toSQL(),
    ).not.toThrow()
  })

  it("CrossTenantJoinError carries the offending table names", () => {
    const db = build(true)
    try {
      db.selectFrom("orders")
        .innerJoin("currency_rates", ({ orders, currency_rates }) =>
          orders.currency.eq(currency_rates.code),
        )
        .selectAll()
        .toSQL()
    } catch (err) {
      expect(err).toBeInstanceOf(CrossTenantJoinError)
      if (err instanceof CrossTenantJoinError) {
        expect(err.table).toBe("orders")
        expect(err.joinedTable).toBe("currency_rates")
      }
      return
    }
    throw new Error("expected throw")
  })
})
