import { Pool } from "pg"
import { sumak } from "sumak"
import { pgDriver } from "sumak/drivers/pg"
import { pgDialect } from "sumak/pg"

import { tables } from "./schema.ts"

/**
 * One pool per process; one sumak instance per pool. Express routes
 * reuse this; per-request scopes (tenant, audit userId) get layered
 * on with `.withSchema(...)` or plugin factories — a fresh Sumak()
 * per request would blow up connection usage.
 */
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export const db = sumak({
  dialect: pgDialect(),
  driver: pgDriver(pool),
  tables,
  onQuery: (ev) => {
    if (ev.phase === "error") {
      console.error(`sql error: ${ev.sql}`, ev.error)
    }
  },
})

export type DB = typeof db
