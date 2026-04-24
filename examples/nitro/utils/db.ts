import { Pool } from "pg"
import { sumak } from "sumak"
import { pgDriver } from "sumak/drivers/pg"
import { pgDialect } from "sumak/pg"

import { tables } from "./schema.ts"

// One Pool per process, cached on globalThis so Nitro's HMR dev
// server doesn't leak connections on every reload. The matching
// `plugins/close-pool.ts` ends the Pool on Nitro's `close` event.
const globalForPool = globalThis as unknown as { __pgPool?: Pool }
const pool =
  globalForPool.__pgPool ?? new Pool({ connectionString: useRuntimeConfig().databaseUrl, max: 10 })
if (process.env.NODE_ENV !== "production") globalForPool.__pgPool = pool

export const db = sumak({ dialect: pgDialect(), driver: pgDriver(pool), tables })
