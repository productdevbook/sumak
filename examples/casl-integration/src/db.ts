import { caslAuthz, pgDialect, subjectType, sumak } from "sumak"
// Driver import elided — use sumak/pg, sumak/mysql, etc. per your
// stack. The plugin wiring is driver-agnostic.

import type { AppAbility } from "./abilities.ts"
import { tables } from "./schema.ts"

/**
 * Build a request-scoped sumak instance for the given ability.
 *
 * **Why per-request?** The `ability` snapshot must match the user
 * making the request. Share the driver/pool globally; build a fresh
 * `sumak()` with fresh plugins on each request — it's cheap (no
 * pool creation, just object wiring) and it keeps authz correct
 * across requests.
 *
 * If you're on Next.js Server Actions / Nuxt event handlers, this
 * factory belongs in a request-scoped context provider. For Express
 * / Fastify, call it inside a middleware and attach `db` to `req`.
 */
export function makeDb(ability: AppAbility /*, driver: Driver */) {
  return sumak({
    dialect: pgDialect(),
    // driver,                    // plug in your pg / mysql2 / … driver
    tables,
    plugins: [
      // Register caslAuthz FIRST: authz filters run before any other
      // plugin rewrites the WHERE. The README explains the ordering
      // rationale in more detail.
      caslAuthz<typeof tables>({
        ability,
        subjects: { posts: "Post", users: "User" },
        // Throw on forbidden (default). Switch to "empty" if you
        // want Postgres-RLS-style silent zero rows.
        onForbidden: "throw",
      }),
      // Optional: stamp __typename on returned rows so other CASL
      // call sites (e.g. ability.can("update", row) after a fetch)
      // match without a manual subject() wrapper.
      subjectType<typeof tables>({ tables: { posts: "Post", users: "User" } }),
    ],
  })
}
