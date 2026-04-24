import { Pool } from "pg"
import { sumak } from "sumak"
import { pgDriver } from "sumak/drivers/pg"
import { pgDialect } from "sumak/pg"

import { tables } from "./schema.ts"

// Module-level initialisation — this runs once per Lambda container
// (the "cold start" path) and is reused across warm invocations. Do
// NOT create the pool inside the handler; every invocation would open
// a fresh connection and blow through RDS's connection limit.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Lambda instances are tiny; one connection is enough and doubles
  // as a natural per-function concurrency cap.
  max: 1,
  // Close idle connections quickly — Lambda freezes the process between
  // invocations, and RDS will kill long-idle sockets.
  idleTimeoutMillis: 10_000,
})

const db = sumak({ dialect: pgDialect(), driver: pgDriver(pool), tables })

interface LambdaEvent {
  userId: string
  kind: string
  payload: unknown
}

interface LambdaContext {
  // API Gateway events carry a deadline; we turn it into an
  // AbortSignal so runaway queries don't get billed for the full
  // 15-minute Lambda max.
  getRemainingTimeInMillis(): number
}

export async function handler(event: LambdaEvent, context: LambdaContext): Promise<{ id: number }> {
  const ac = new AbortController()
  const timeout = setTimeout(
    () => ac.abort(),
    // Leave 500ms for cleanup + Lambda response envelope.
    Math.max(context.getRemainingTimeInMillis() - 500, 100),
  )

  try {
    const [row] = await db
      .insertInto("events")
      .values({
        userId: event.userId,
        kind: event.kind,
        payload: JSON.stringify(event.payload),
      })
      .returning("id")
      .many({ signal: ac.signal })
    return { id: row!.id }
  } finally {
    clearTimeout(timeout)
  }
}
