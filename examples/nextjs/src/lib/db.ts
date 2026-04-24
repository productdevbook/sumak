import "server-only"
import { Pool } from "pg"
import { sumak } from "sumak"
import { pgDriver } from "sumak/drivers/pg"
import { pgDialect } from "sumak/pg"
import { multiTenant } from "sumak/plugin"

import { tables } from "./schema.ts"

// Next.js bundles server code per route, but a module-level `pool`
// lives in the long-lived Node worker — so the same Pool is reused
// across requests. `globalThis` guards against HMR duplicating it in
// dev.
const globalForPool = globalThis as unknown as { __pgPool?: Pool }
const pool =
  globalForPool.__pgPool ?? new Pool({ connectionString: process.env.DATABASE_URL, max: 10 })
if (process.env.NODE_ENV !== "production") globalForPool.__pgPool = pool

const baseDb = sumak({ dialect: pgDialect(), driver: pgDriver(pool), tables })

/**
 * Per-request DB handle scoped to a tenant. Server actions / route
 * handlers call `dbFor(tenantId)` at the top of the request — every
 * subsequent query is automatically filtered by `tenantId`, with
 * strict mode refusing inserts that try to set a different value.
 */
export function dbFor(tenantId: number) {
  return baseDb.use(multiTenant({ tenantId, strict: true }))
}

export type TenantDb = ReturnType<typeof dbFor>
