import { describe, expect, it } from "vitest"

import {
  coalesce,
  concat,
  greatest,
  jsonBuildObject,
  least,
  tuple,
  val,
} from "../../src/builder/eb.ts"
import { InvalidExpressionError } from "../../src/errors.ts"

// These tests lock down the builder-time arity guards so a future
// refactor can't silently remove them. Every function here produces
// invalid SQL on at least one supported dialect when given fewer than
// the minimum number of args — so we'd rather error at call site than
// at driver parse time.

describe("builder arity validation", () => {
  describe("coalesce", () => {
    it("rejects zero args", () => {
      expect(() => coalesce()).toThrow(InvalidExpressionError)
      expect(() => coalesce()).toThrow(/at least one argument/)
    })
    it("accepts one arg", () => {
      expect(() => coalesce(val<string | null>("a"))).not.toThrow()
    })
  })

  describe("concat", () => {
    it("rejects zero args", () => {
      expect(() => concat()).toThrow(InvalidExpressionError)
    })
    it("accepts one arg", () => {
      expect(() => concat(val("a"))).not.toThrow()
    })
  })

  describe("greatest / least", () => {
    it("reject zero and one arg", () => {
      expect(() => greatest<number>()).toThrow(InvalidExpressionError)
      expect(() => greatest<number>(val(1))).toThrow(/at least two/)
      expect(() => least<number>()).toThrow(InvalidExpressionError)
      expect(() => least<number>(val(1))).toThrow(/at least two/)
    })
    it("accept two or more args", () => {
      expect(() => greatest<number>(val(1), val(2))).not.toThrow()
      expect(() => least<number>(val(1), val(2), val(3))).not.toThrow()
    })
  })

  describe("jsonBuildObject", () => {
    it("rejects zero pairs", () => {
      expect(() => jsonBuildObject()).toThrow(InvalidExpressionError)
      expect(() => jsonBuildObject()).toThrow(/at least one/)
    })
    it("accepts one pair", () => {
      expect(() => jsonBuildObject(["k", val("v")])).not.toThrow()
    })
  })

  describe("tuple", () => {
    it("rejects zero args (empty `()` is a syntax error everywhere)", () => {
      expect(() => tuple()).toThrow(InvalidExpressionError)
    })
    it("allows single-element tuple (prints as parenthesized expression)", () => {
      expect(() => tuple(val(1))).not.toThrow()
    })
  })

  describe("error shape", () => {
    it("reports the builder name + actual arg count", () => {
      try {
        greatest<number>(val(1))
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidExpressionError)
        expect((err as Error).message).toMatch(/greatest\(\)/)
        expect((err as Error).message).toMatch(/got 1/)
      }
    })
  })
})
