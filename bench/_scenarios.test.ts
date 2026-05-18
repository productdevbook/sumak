import { describe, expect, it } from "vitest"

import { scenarios } from "./src/scenarios.ts"

/**
 * Smoke test — verifies every scenario in scenarios.ts produces valid
 * SQL across sumak / drizzle / kysely. Catches the class of bug where
 * a builder call silently no-ops (e.g. extra args ignored at runtime,
 * which is exactly what happened to the original `.where("col", "=",
 * val)` scenarios — the bench was measuring sumak doing less work than
 * the competitors).
 *
 * Param count is intentionally NOT pinned across libraries: sumak
 * inlines LIMIT/OFFSET as integer literals while kysely parameterizes
 * them, and drizzle sometimes inlines values the others parameterize.
 * Snapshotting full SQL + params catches divergence without a brittle
 * structural assertion.
 *
 * Run with: pnpm vitest run bench/_scenarios.test.ts
 */
describe("bench scenarios produce equivalent SQL", () => {
  for (const sc of scenarios) {
    describe(sc.name, () => {
      it("all three libraries compile to non-empty SQL", () => {
        const s = sc.sumak()
        const k = sc.kysely()
        const d = sc.drizzle()
        expect(s.sql.length, "sumak SQL is non-empty").toBeGreaterThan(0)
        expect(k.sql.length, "kysely SQL is non-empty").toBeGreaterThan(0)
        expect(d.sql.length, "drizzle SQL is non-empty").toBeGreaterThan(0)
      })

      // WHERE-bearing scenarios need to carry their WHERE through — the
      // original silent-no-op bug surfaced as zero params on sumak when
      // every competitor had the predicate parameterized. We only check
      // sumak ≥ 1 param against kysely ≥ 1 param, so LIMIT-only inlining
      // doesn't false-positive.
      if (sc.name.includes("where") || sc.name === "update-where" || sc.name === "delete-where") {
        it("the WHERE-bearing scenario actually emits parameters", () => {
          const s = sc.sumak()
          const k = sc.kysely()
          if (k.params.length === 0) return
          expect(s.params.length, `sumak ${sc.name} dropped its WHERE clause`).toBeGreaterThan(0)
        })
      }

      it("snapshot of generated SQL", () => {
        const s = sc.sumak()
        const k = sc.kysely()
        const d = sc.drizzle()
        expect({ sumak: s, kysely: k, drizzle: d }).toMatchSnapshot()
      })
    })
  }
})
