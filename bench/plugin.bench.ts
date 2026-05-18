import { bench, describe } from "vitest"

import { pgDialect } from "../src/dialect/pg.ts"
import { audit } from "../src/plugin/factories.ts"
import { camelCase } from "../src/plugin/factories.ts"
import { multiTenant } from "../src/plugin/factories.ts"
import { softDelete } from "../src/plugin/factories.ts"
import { subjectType } from "../src/plugin/factories.ts"
import { integer, serial, text, timestamp } from "../src/schema/index.ts"
import { sumak } from "../src/sumak.ts"

/**
 * Plugin-overhead microbench (sumak-only — kysely/drizzle don't have
 * a comparable plugin layer).
 *
 * Each scenario builds the SAME query (a simple SELECT) against a
 * sumak instance with N plugins registered. The cost we're measuring
 * is the per-compile overhead each plugin adds to `db.compile()`:
 *
 *   - softDelete walks the SELECT AST to AND `deleted_at IS NULL`
 *   - multiTenant injects `tenant_id = $N` for every mapped table
 *   - audit timestamps INSERT/UPDATE (no SELECT cost, included as
 *     a "no-op on read" baseline)
 *   - camelCase rewrites identifiers on the way out (snake_case → camelCase)
 *   - subjectType stamps __typename on result rows (compile cost is
 *     zero; included as a sanity check)
 *
 * The "baseline" scenario uses no plugins so each later number can be
 * read as "1 + overhead". Numbers are hz on the same hardware; the
 * gap to baseline is the plugin's compile-time cost.
 *
 * Run with:
 *   pnpm vitest bench --run bench/plugin.bench.ts
 */

const tables = {
  users: {
    id: serial().primaryKey(),
    name: text().notNull(),
    email: text().notNull(),
    tenantId: integer().notNull(),
    deletedAt: timestamp().nullable(),
    createdAt: timestamp().notNull(),
    updatedAt: timestamp().notNull(),
  },
}

const baseline = sumak({ dialect: pgDialect(), tables })

const withSoftDelete = sumak({
  dialect: pgDialect(),
  tables,
  plugins: [softDelete({ tables: ["users"] })],
})

const withMultiTenant = sumak({
  dialect: pgDialect(),
  tables,
  plugins: [multiTenant({ tables: ["users"], tenantId: () => 42 })],
})

const withAudit = sumak({
  dialect: pgDialect(),
  tables,
  plugins: [audit({ tables: ["users"] })],
})

const withCamelCase = sumak({
  dialect: pgDialect(),
  tables,
  plugins: [camelCase()],
})

const withSubjectType = sumak({
  dialect: pgDialect(),
  tables,
  plugins: [subjectType({ tables: { users: "User" } })],
})

const withAll = sumak({
  dialect: pgDialect(),
  tables,
  plugins: [
    softDelete({ tables: ["users"] }),
    multiTenant({ tables: ["users"], tenantId: () => 42 }),
    audit({ tables: ["users"] }),
    camelCase(),
    subjectType({ tables: { users: "User" } }),
  ],
})

function selectQuery(db: typeof baseline): { sql: string; params: readonly unknown[] } {
  return db
    .selectFrom("users")
    .select("id", "name")
    .where(({ id }) => id.eq(1))
    .toSQL()
}

describe("plugin compile overhead", () => {
  bench("baseline (no plugins)", () => {
    selectQuery(baseline)
  })

  bench("+ softDelete", () => {
    selectQuery(withSoftDelete)
  })

  bench("+ multiTenant", () => {
    selectQuery(withMultiTenant)
  })

  bench("+ audit", () => {
    selectQuery(withAudit)
  })

  bench("+ camelCase", () => {
    selectQuery(withCamelCase)
  })

  bench("+ subjectType (result-only)", () => {
    selectQuery(withSubjectType)
  })

  bench("+ ALL FIVE plugins", () => {
    selectQuery(withAll)
  })
})
