import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { mssqlDialect } from "../../../src/dialect/mssql.ts"
import type { Driver } from "../../../src/driver/types.ts"
import { introspectMssql } from "../../../src/introspect/mssql.ts"
import { applyMigration } from "../../../src/migrate/runner.ts"
import { integer, serial, text } from "../../../src/schema/column.ts"
import { defineTable } from "../../../src/schema/table.ts"
import { sumak } from "../../../src/sumak.ts"

// Real-MSSQL roundtrip. Skipped unless INTEGRATION_DB=1 is set.
// Start with:
//
//   docker compose -f test/integration/dockerized/docker-compose.yml up -d
//
// MSSQL's 2022 image has a known ~30s boot time — the suite waits
// for the healthcheck before running, but be patient on the first
// `docker compose up`.

const enabled =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.INTEGRATION_DB === "1"

let driver: Driver
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pool: any

beforeAll(async () => {
  if (!enabled) return
  const mssql = (await import("mssql" as string).catch(() => null)) as {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ConnectionPool: new (cfg: unknown) => any
  } | null
  if (!mssql) {
    throw new Error("mssql is not installed. Run `pnpm add -D mssql` to enable integration tests.")
  }
  pool = new mssql.ConnectionPool({
    server: "127.0.0.1",
    port: 1434,
    user: "SA",
    password: "SumakTest1!",
    database: "master",
    options: { trustServerCertificate: true, encrypt: false },
  })
  await pool.connect()
  const { mssqlDriver } = await import("../../../src/drivers/mssql.ts")
  driver = mssqlDriver(pool)
})

afterAll(async () => {
  if (!enabled) return
  await pool?.close?.()
})

describe.skipIf(!enabled)("mssql — real server roundtrip", () => {
  it("applies DDL, introspects it back, runs a SELECT", async () => {
    const tables = {
      it_mssql_users: defineTable(
        "it_mssql_users",
        {
          id: serial().primaryKey(),
          email: text().notNull().unique(),
          name: text().notNull(),
        },
        {},
      ),
      it_mssql_posts: defineTable(
        "it_mssql_posts",
        {
          id: serial().primaryKey(),
          authorId: integer().notNull().references("it_mssql_users", "id"),
          title: text().notNull(),
        },
        {},
      ),
    }
    const db = sumak({ dialect: mssqlDialect(), driver, tables })

    // Clean slate. MSSQL's FK drop-order is finicky; explicit order
    // + IF EXISTS guard keeps reruns idempotent.
    await driver.execute(
      "IF OBJECT_ID('it_mssql_posts', 'U') IS NOT NULL DROP TABLE it_mssql_posts",
      [],
    )
    await driver.execute(
      "IF OBJECT_ID('it_mssql_users', 'U') IS NOT NULL DROP TABLE it_mssql_users",
      [],
    )

    await applyMigration(db, {}, tables, { transaction: false })

    const introspected = await introspectMssql(driver)
    const usersTable = introspected.tables.find((t) => t.name === "it_mssql_users")
    expect(usersTable).toBeDefined()
    expect(usersTable?.columns.find((c) => c.name === "email")?.isUnique).toBe(true)

    const postsTable = introspected.tables.find((t) => t.name === "it_mssql_posts")
    const fk = postsTable?.columns.find((c) => c.name === "authorId")?.references
    expect(fk?.table).toBe("it_mssql_users")
    expect(fk?.column).toBe("id")

    await db
      .insertInto("it_mssql_users")
      .values({ id: 1, email: "ada@x.io", name: "Ada" } as never)
      .exec()

    const [row] = await db
      .selectFrom("it_mssql_users")
      .select("id", "email", "name")
      .where(({ id }) => id.eq(1))
      .many()
    expect(row?.email).toBe("ada@x.io")

    await driver.execute("DROP TABLE it_mssql_posts", [])
    await driver.execute("DROP TABLE it_mssql_users", [])
  })
})
