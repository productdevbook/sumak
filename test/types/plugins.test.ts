import { describe, expectTypeOf, it } from "vitest"

import type {
  OnQueryListener,
  QueryEndEvent,
  QueryErrorEvent,
  QueryEvent,
  QueryStartEvent,
} from "../../src/driver/types.ts"
import { audit, multiTenant, softDelete, subjectType } from "../../src/plugin/factories.ts"
import type { ResultContext, SumakPlugin } from "../../src/plugin/types.ts"

// Plugin factory return types, shared plugin shape, and the OnQuery
// discriminated union all need to stay stable — every commit that
// touches `src/plugin/*` risks breaking consumers who import these.

describe("Plugin factories — return type is SumakPlugin", () => {
  it("softDelete()", () => {
    expectTypeOf(softDelete({ tables: ["users"] })).toMatchTypeOf<SumakPlugin>()
  })
  it("multiTenant()", () => {
    expectTypeOf(multiTenant({ tables: ["users"], tenantId: () => 1 })).toMatchTypeOf<SumakPlugin>()
  })
  it("audit()", () => {
    expectTypeOf(audit({ tables: ["users"] })).toMatchTypeOf<SumakPlugin>()
  })
  it("subjectType()", () => {
    expectTypeOf(
      subjectType({ tables: { users: "User", posts: "Post" } }),
    ).toMatchTypeOf<SumakPlugin>()
  })
})

describe("ResultContext — surfaced shape", () => {
  it("has table (string?) and columnSources (Record<string, string>?)", () => {
    // The actual shape sumak hands to transformResult. Locking these
    // fields means plugin authors can rely on them without a `// @ts-`
    // escape hatch.
    const ctx: ResultContext = { table: "users", columnSources: { id: "users", name: "users" } }
    expectTypeOf(ctx.table).toEqualTypeOf<string | undefined>()
    expectTypeOf(ctx.columnSources).toEqualTypeOf<Readonly<Record<string, string>> | undefined>()
  })
})

describe("OnQueryListener + QueryEvent discriminated union", () => {
  it("QueryEvent narrows on `phase`", () => {
    const handler: OnQueryListener = (event) => {
      // Start branch: no durationMs, no rowCount, no error.
      if (event.phase === "start") {
        expectTypeOf(event).toEqualTypeOf<QueryStartEvent>()
        // @ts-expect-error — only on end events.
        event.rowCount
        // @ts-expect-error — only on end/error events.
        event.durationMs
      }
      // End branch: durationMs + optional rowCount / affected.
      if (event.phase === "end") {
        expectTypeOf(event).toEqualTypeOf<QueryEndEvent>()
        expectTypeOf(event.durationMs).toEqualTypeOf<number>()
      }
      // Error branch: durationMs + error.
      if (event.phase === "error") {
        expectTypeOf(event).toEqualTypeOf<QueryErrorEvent>()
        expectTypeOf(event.error).toEqualTypeOf<unknown>()
      }
    }
    expectTypeOf(handler).toMatchTypeOf<(e: QueryEvent) => void>()
  })

  it("event.kind narrows transaction vs query/execute", () => {
    const handler: OnQueryListener = (event) => {
      if (event.kind === "transaction") {
        // `txPhase` is only meaningful on transaction events, but
        // its field is on the shared base — it's optional elsewhere.
        expectTypeOf(event.txPhase).toEqualTypeOf<"begin" | "commit" | "rollback" | undefined>()
      }
    }
    void handler
  })
})
