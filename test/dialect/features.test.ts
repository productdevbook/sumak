import { describe, expect, it } from "vitest"

import {
  assertFeature,
  dialectsForFeature,
  FEATURES,
  supportsFeature,
} from "../../src/dialect/features.ts"
import { UnsupportedDialectFeatureError } from "../../src/errors.ts"
import type { SQLDialect } from "../../src/types.ts"

const ALL_DIALECTS: SQLDialect[] = ["pg", "mysql", "sqlite", "mssql"]

describe("dialect feature matrix", () => {
  it("every feature declares at least one supporting dialect", () => {
    for (const [key, def] of Object.entries(FEATURES)) {
      expect(def.dialects.length, `feature ${key} has no dialects`).toBeGreaterThan(0)
    }
  })

  it("every feature uses only known dialect identifiers", () => {
    for (const [key, def] of Object.entries(FEATURES)) {
      for (const d of def.dialects) {
        expect(ALL_DIALECTS, `feature ${key} uses unknown dialect "${d}"`).toContain(d)
      }
    }
  })

  it("every feature has a non-empty user-facing label", () => {
    for (const [key, def] of Object.entries(FEATURES)) {
      expect(def.label.trim().length, `feature ${key} has empty label`).toBeGreaterThan(0)
    }
  })

  it("feature keys are unique (enforced by TS Record but assert)", () => {
    const keys = Object.keys(FEATURES)
    expect(new Set(keys).size).toBe(keys.length)
  })

  describe("supportsFeature", () => {
    it("agrees with the matrix entry", () => {
      expect(supportsFeature("pg", "DISTINCT_ON")).toBe(true)
      expect(supportsFeature("mysql", "DISTINCT_ON")).toBe(false)
      expect(supportsFeature("sqlite", "DISTINCT_ON")).toBe(false)
      expect(supportsFeature("mssql", "DISTINCT_ON")).toBe(false)

      expect(supportsFeature("mysql", "ON_DUPLICATE_KEY_UPDATE")).toBe(true)
      expect(supportsFeature("pg", "ON_DUPLICATE_KEY_UPDATE")).toBe(false)

      expect(supportsFeature("pg", "WINDOW_FUNCTIONS")).toBe(true)
      expect(supportsFeature("mysql", "WINDOW_FUNCTIONS")).toBe(true)
      expect(supportsFeature("sqlite", "WINDOW_FUNCTIONS")).toBe(true)
      expect(supportsFeature("mssql", "WINDOW_FUNCTIONS")).toBe(true)
    })
  })

  describe("assertFeature", () => {
    it("no-ops when supported", () => {
      expect(() => assertFeature("pg", "RETURNING")).not.toThrow()
    })

    it("throws UnsupportedDialectFeatureError with feature label in message", () => {
      expect(() => assertFeature("mysql", "RETURNING")).toThrow(UnsupportedDialectFeatureError)
      try {
        assertFeature("mysql", "RETURNING")
      } catch (err) {
        expect((err as Error).message).toContain("RETURNING")
        expect((err as Error).message).toContain("mysql")
      }
    })
  })

  describe("dialectsForFeature", () => {
    it("returns the configured list", () => {
      expect([...dialectsForFeature("DISTINCT_ON")]).toEqual(["pg"])
      const onConflict = [...dialectsForFeature("ON_CONFLICT")].sort()
      expect(onConflict).toEqual(["pg", "sqlite"])
    })
  })

  describe("cross-feature sanity", () => {
    it("RETURNING_UPDATE ⊆ RETURNING (UPDATE variant never supported alone)", () => {
      const ret = new Set(dialectsForFeature("RETURNING"))
      for (const d of dialectsForFeature("RETURNING_UPDATE")) {
        expect(ret.has(d), `${d} supports RETURNING_UPDATE but not RETURNING`).toBe(true)
      }
    })

    it("FOR_UPDATE_OF ⊆ FOR_UPDATE", () => {
      const base = new Set(dialectsForFeature("FOR_UPDATE"))
      for (const d of dialectsForFeature("FOR_UPDATE_OF")) {
        expect(base.has(d), `${d} supports FOR_UPDATE_OF but not FOR_UPDATE`).toBe(true)
      }
    })

    it("SKIP_LOCKED + NOWAIT ⊆ FOR_UPDATE", () => {
      const base = new Set(dialectsForFeature("FOR_UPDATE"))
      for (const d of dialectsForFeature("SKIP_LOCKED")) {
        expect(base.has(d)).toBe(true)
      }
      for (const d of dialectsForFeature("NOWAIT")) {
        expect(base.has(d)).toBe(true)
      }
    })
  })
})
