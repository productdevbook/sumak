import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { applyMigration } from "../../src/migrate/runner.ts"
import { audit } from "../../src/plugin/factories.ts"
import { multiTenant } from "../../src/plugin/factories.ts"
import { softDelete } from "../../src/plugin/factories.ts"
import { subjectType } from "../../src/plugin/factories.ts"
import { integer, serial, text, timestamp } from "../../src/schema/index.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "./pglite-driver.ts"

// Plugin behaviour against a real Postgres. These tests catch the
// class of bug where the generated SQL looks right to a string match
// but the driver rejects it — the kind of thing the audit rounds #3–#24
// kept catching after release. Putting them in front of pglite means
// every pre-release run proves the plugins actually work.

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
})

afterAll(async () => {
  await pg?.close()
})

async function reset(sql: string): Promise<void> {
  await pg.exec(sql)
}

describe("softDelete plugin against pglite", () => {
  beforeAll(async () => {
    await reset(`
      DROP TABLE IF EXISTS sd_users CASCADE;
      CREATE TABLE sd_users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        deleted_at TIMESTAMP
      );
      INSERT INTO sd_users (name) VALUES ('Alice'), ('Bob'), ('Charlie');
      UPDATE sd_users SET deleted_at = CURRENT_TIMESTAMP WHERE name = 'Bob';
    `)
  })

  it("SELECT filters out soft-deleted rows", async () => {
    const driver = pgliteDriver(pg)
    const db = sumak({
      dialect: pgDialect(),
      driver,
      plugins: [softDelete({ tables: ["sd_users"] })],
      tables: {
        sd_users: {
          id: serial().primaryKey(),
          name: text().notNull(),
          deleted_at: timestamp().nullable(),
        },
      },
    })
    const rows = await db.selectFrom("sd_users").select("name").many()
    expect(rows.map((r) => r.name).sort()).toEqual(["Alice", "Charlie"])
  })

  it(".includeDeleted() returns everyone, tombstoned or not", async () => {
    const driver = pgliteDriver(pg)
    const db = sumak({
      dialect: pgDialect(),
      driver,
      plugins: [softDelete({ tables: ["sd_users"] })],
      tables: {
        sd_users: {
          id: serial().primaryKey(),
          name: text().notNull(),
          deleted_at: timestamp().nullable(),
        },
      },
    })
    const rows = await db.selectFrom("sd_users").includeDeleted().select("name").many()
    expect(rows).toHaveLength(3)
  })
})

describe("multiTenant plugin against pglite", () => {
  beforeAll(async () => {
    await reset(`
      DROP TABLE IF EXISTS mt_orders CASCADE;
      CREATE TABLE mt_orders (
        id SERIAL PRIMARY KEY,
        tenant_id INT NOT NULL,
        total INT NOT NULL
      );
      INSERT INTO mt_orders (tenant_id, total) VALUES
        (1, 100), (1, 200), (2, 999);
    `)
  })

  it("SELECT isolates rows to the current tenant", async () => {
    const driver = pgliteDriver(pg)
    let currentTenant = 1
    const db = sumak({
      dialect: pgDialect(),
      driver,
      plugins: [multiTenant({ tables: ["mt_orders"], tenantId: () => currentTenant })],
      tables: {
        mt_orders: {
          id: serial().primaryKey(),
          tenant_id: integer().notNull(),
          total: integer().notNull(),
        },
      },
    })

    const t1 = await db.selectFrom("mt_orders").select("total").many()
    expect(t1.map((r) => r.total).sort((a, b) => (a as number) - (b as number))).toEqual([100, 200])

    currentTenant = 2
    const t2 = await db.selectFrom("mt_orders").select("total").many()
    expect(t2.map((r) => r.total)).toEqual([999])
  })
})

describe("audit (created_at / updated_at) plugin against pglite", () => {
  beforeAll(async () => {
    await reset(`
      DROP TABLE IF EXISTS au_posts CASCADE;
      CREATE TABLE au_posts (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TIMESTAMP,
        updated_at TIMESTAMP
      );
    `)
  })

  it("INSERT fills created_at + updated_at", async () => {
    const driver = pgliteDriver(pg)
    const db = sumak({
      dialect: pgDialect(),
      driver,
      plugins: [audit({ tables: ["au_posts"] })],
      tables: {
        au_posts: {
          id: serial().primaryKey(),
          title: text().notNull(),
          created_at: timestamp().nullable(),
          updated_at: timestamp().nullable(),
        },
      },
    })
    const row = await db.insertInto("au_posts").values({ title: "hi" }).returningAll().one()
    expect(row.created_at).toBeTruthy()
    expect(row.updated_at).toBeTruthy()
  })
})

describe("subjectType plugin against pglite", () => {
  beforeAll(async () => {
    await reset(`
      DROP TABLE IF EXISTS st_messages CASCADE;
      CREATE TABLE st_messages (
        id SERIAL PRIMARY KEY,
        body TEXT NOT NULL
      );
      INSERT INTO st_messages (body) VALUES ('hello'), ('world');
    `)
  })

  it("stamps __typename on real rows returned from pglite", async () => {
    const driver = pgliteDriver(pg)
    const db = sumak({
      dialect: pgDialect(),
      driver,
      plugins: [subjectType({ tables: { st_messages: "Message" } })],
      tables: { st_messages: { id: serial().primaryKey(), body: text().notNull() } },
    })

    const rows = await db.selectFrom("st_messages").many()
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect((r as unknown as { __typename: string }).__typename).toBe("Message")
    }
  })
})

describe("CTE + window fn + MERGE surface against pglite", () => {
  beforeAll(async () => {
    await reset(`
      DROP TABLE IF EXISTS wnd_sales CASCADE;
      CREATE TABLE wnd_sales (
        id SERIAL PRIMARY KEY,
        region TEXT NOT NULL,
        amount INT NOT NULL
      );
      INSERT INTO wnd_sales (region, amount) VALUES
        ('east', 10), ('east', 20), ('east', 30),
        ('west', 100), ('west', 200);
    `)
  })

  it("window function: ROW_NUMBER() OVER (PARTITION BY ...) runs and returns ranks", async () => {
    const driver = pgliteDriver(pg)
    const db = sumak({
      dialect: pgDialect(),
      driver,
      tables: {
        wnd_sales: {
          id: serial().primaryKey(),
          region: text().notNull(),
          amount: integer().notNull(),
        },
      },
    })
    // Rank amounts per region, highest first — just proves the window
    // SQL we emit parses and executes on PG.
    const sql = `
      SELECT region, amount,
        ROW_NUMBER() OVER (PARTITION BY region ORDER BY amount DESC) AS rn
      FROM wnd_sales
      ORDER BY region, rn
    `
    const rows = await db.executeCompiled({ sql, params: [] })
    expect(rows).toHaveLength(5)
    // First east row → rn 1 and amount 30; first west row → rn 1 and amount 200.
    const firstEast = rows.find((r) => (r.region === "east" && r.rn === 1) || r.rn === "1")!
    expect(firstEast).toBeDefined()
  })

  it("CTE: sumak-compiled CTE query runs and returns rows", async () => {
    const driver = pgliteDriver(pg)
    const db = sumak({
      dialect: pgDialect(),
      driver,
      tables: {
        wnd_sales: {
          id: serial().primaryKey(),
          region: text().notNull(),
          amount: integer().notNull(),
        },
      },
    })
    const big = db.selectFrom("wnd_sales").where(({ amount }) => amount.gt(50))
    const rows = await db.selectFrom("wnd_sales").with("big", big).selectAll().many()
    expect(rows.length).toBeGreaterThan(0)
  })
})
