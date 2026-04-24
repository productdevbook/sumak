import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { mysqlDialect } from "../../../src/dialect/mysql.ts"
import type { Driver } from "../../../src/driver/types.ts"
import { introspectMysql } from "../../../src/introspect/mysql.ts"
import { applyMigration } from "../../../src/migrate/runner.ts"
import { integer, serial, text } from "../../../src/schema/column.ts"
import { defineTable } from "../../../src/schema/table.ts"
import { sumak } from "../../../src/sumak.ts"

// Real-MySQL roundtrip. Skipped unless INTEGRATION_DB=1 is set,
// because it needs the docker-compose MySQL running. Spin up with:
//
//   docker compose -f test/integration/dockerized/docker-compose.yml up -d
//
// The suite exercises:
//   - DDL applied through sumak's migration runner
//   - constraints round-trip via `introspectMysql`
//   - basic SELECT/INSERT against the actual server (catches cases
//     where mock drivers were too forgiving)

const enabled =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.INTEGRATION_DB === "1"

let driver: Driver
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pool: any

beforeAll(async () => {
  if (!enabled) return
  // Dynamic import so the absence of mysql2 doesn't fail `pnpm test`.
  const mysql2 = (await import("mysql2/promise" as string).catch(() => null)) as {
    createPool: (cfg: unknown) => unknown
  } | null
  if (!mysql2) {
    throw new Error(
      "mysql2 is not installed. Run `pnpm add -D mysql2` to enable integration tests.",
    )
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pool = mysql2.createPool({
    host: "127.0.0.1",
    port: 3307,
    user: "root",
    password: "sumak",
    database: "sumak_test",
    connectionLimit: 2,
  }) as any
  const { mysql2Driver } = await import("../../../src/drivers/mysql2.ts")
  driver = mysql2Driver(pool)
})

afterAll(async () => {
  if (!enabled) return
  await pool?.end?.()
})

describe.skipIf(!enabled)("mysql — real server roundtrip", () => {
  it("applies DDL, introspects it back, runs a SELECT", async () => {
    const tables = {
      it_mysql_users: defineTable(
        "it_mysql_users",
        {
          id: serial().primaryKey(),
          email: text().notNull().unique(),
          name: text().notNull(),
        },
        {},
      ),
      it_mysql_posts: defineTable(
        "it_mysql_posts",
        {
          id: serial().primaryKey(),
          authorId: integer().notNull().references("it_mysql_users", "id"),
          title: text().notNull(),
        },
        {},
      ),
    }
    const db = sumak({ dialect: mysqlDialect(), driver, tables })

    // Clean slate — drop any leftover tables from a previous failed run.
    await driver.execute("DROP TABLE IF EXISTS it_mysql_posts", [])
    await driver.execute("DROP TABLE IF EXISTS it_mysql_users", [])

    await applyMigration(db, {}, tables, { transaction: false })

    const introspected = await introspectMysql(driver, { database: "sumak_test" })
    const usersTable = introspected.tables.find((t) => t.name === "it_mysql_users")
    expect(usersTable).toBeDefined()
    expect(usersTable?.columns.find((c) => c.name === "email")?.isUnique).toBe(true)

    const postsTable = introspected.tables.find((t) => t.name === "it_mysql_posts")
    const fk = postsTable?.columns.find((c) => c.name === "authorId")?.references
    expect(fk?.table).toBe("it_mysql_users")
    expect(fk?.column).toBe("id")

    await db
      .insertInto("it_mysql_users")
      .values({ id: 1, email: "ada@x.io", name: "Ada" } as never)
      .exec()

    const [row] = await db
      .selectFrom("it_mysql_users")
      .select("id", "email", "name")
      .where(({ id }) => id.eq(1))
      .many()
    expect(row?.email).toBe("ada@x.io")

    await driver.execute("DROP TABLE it_mysql_posts", [])
    await driver.execute("DROP TABLE it_mysql_users", [])
  })
})
