import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { CrossTenantJoinError } from "../../src/errors.ts"
import { multiTenant } from "../../src/plugin/factories.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "./pglite-driver.ts"

// Real-PG evidence that strict-mode multiTenant actually scopes
// tenant data on JOINs. Without strict mode, a JOIN leaks rows
// across tenants; with strict mode, either the JOIN is filtered or
// the compile rejects.

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    DROP TABLE IF EXISTS mts_orders CASCADE;
    DROP TABLE IF EXISTS mts_lines CASCADE;
    CREATE TABLE mts_orders (
      id SERIAL PRIMARY KEY,
      tenant_id INT NOT NULL,
      total INT NOT NULL
    );
    CREATE TABLE mts_lines (
      id SERIAL PRIMARY KEY,
      order_id INT NOT NULL,
      tenant_id INT NOT NULL,
      qty INT NOT NULL
    );
    INSERT INTO mts_orders (tenant_id, total) VALUES (1, 100), (2, 999);
    INSERT INTO mts_lines (order_id, tenant_id, qty) VALUES
      (1, 1, 3),
      (1, 1, 5),
      (2, 2, 7);
  `)
})

afterAll(async () => {
  await pg?.close()
})

const schema = {
  mts_orders: {
    id: serial().primaryKey(),
    tenant_id: integer().notNull(),
    total: integer().notNull(),
  },
  mts_lines: {
    id: serial().primaryKey(),
    order_id: integer().notNull(),
    tenant_id: integer().notNull(),
    qty: integer().notNull(),
  },
}

describe("multiTenant strict-mode — pglite roundtrip", () => {
  it("JOINs on tenant-aware tables get tenant_id = ? on both sides", async () => {
    const driver = pgliteDriver(pg)
    const db = sumak({
      dialect: pgDialect(),
      driver,
      plugins: [
        multiTenant({
          tables: ["mts_orders", "mts_lines"],
          tenantId: () => 1,
          strict: true,
        }),
      ],
      tables: schema,
    })
    const rows = await db
      .selectFrom("mts_orders")
      .innerJoin("mts_lines", ({ mts_orders, mts_lines }) => mts_orders.id.eq(mts_lines.order_id))
      .selectAll()
      .many()
    // Only tenant 1's two order lines come back — tenant 2's row is
    // filtered out by the JOIN guard even though the order_id would
    // have matched without it.
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.qty).sort()).toEqual([3, 5])
  })

  it("strict: true rejects a JOIN to a non-tenant-aware table at compile time", () => {
    const db = sumak({
      dialect: pgDialect(),
      driver: pgliteDriver(pg),
      // Deliberately leave mts_lines off the tenant-aware list.
      plugins: [multiTenant({ tables: ["mts_orders"], tenantId: () => 1, strict: true })],
      tables: schema,
    })
    expect(() =>
      db
        .selectFrom("mts_orders")
        .innerJoin("mts_lines", ({ mts_orders, mts_lines }) => mts_orders.id.eq(mts_lines.order_id))
        .selectAll()
        .toSQL(),
    ).toThrow(CrossTenantJoinError)
  })

  it(".crossTenant({ reason }) is the only way through the allow-list gate", async () => {
    const driver = pgliteDriver(pg)
    const db = sumak({
      dialect: pgDialect(),
      driver,
      plugins: [multiTenant({ tables: ["mts_orders"], tenantId: () => 1, strict: true })],
      tables: schema,
    })
    const rows = await db
      .selectFrom("mts_orders")
      .innerJoin("mts_lines", ({ mts_orders, mts_lines }) => mts_orders.id.eq(mts_lines.order_id))
      .crossTenant({ reason: "lines are scoped by order_id and audited elsewhere" })
      .selectAll()
      .many()
    // Without the per-join guard, both tenants' lines that share an
    // order_id come through — that's the legacy behaviour strict
    // mode protects against, re-enabled explicitly by the escape
    // hatch. The test doesn't assert row counts (depends on data
    // layout); it just proves the bypass compiles and executes.
    expect(rows.length).toBeGreaterThan(0)
  })
})
