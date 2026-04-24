import { Pool } from "pg"
import { sumak } from "sumak"
import { pgDriver } from "sumak/drivers/pg"
import { pgDialect } from "sumak/pg"
import { multiTenant } from "sumak/plugin"

import { tables } from "./schema.ts"

// Nuxt's Nitro server bundles `server/utils/` into every route via
// auto-imports. We cache the pool on globalThis so HMR doesn't
// duplicate it — same trick as the Next.js example, different
// framework.
const globalForPool = globalThis as unknown as { __pgPool?: Pool }
const pool =
  globalForPool.__pgPool ?? new Pool({ connectionString: useRuntimeConfig().databaseUrl, max: 10 })
if (process.env.NODE_ENV !== "production") globalForPool.__pgPool = pool

const baseDb = sumak({ dialect: pgDialect(), driver: pgDriver(pool), tables })

/**
 * Request-scoped DB handle. Every route handler calls `dbFor(tid)`
 * with the tenant id pulled from the session; multiTenant strict
 * mode injects `WHERE tenantId = $tid` on every query and rejects
 * cross-tenant inserts at compile time.
 */
export function dbFor(tenantId: number) {
  return baseDb.use(multiTenant({ tenantId, strict: true }))
}
