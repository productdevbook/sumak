import { describe, expect, it } from "vitest"
import { formatParam } from "../../src/utils/param.ts"

describe("formatParam", () => {
  it("formats pg params as $N (1-indexed)", () => {
    expect(formatParam(0, "pg")).toBe("$1")
    expect(formatParam(1, "pg")).toBe("$2")
    expect(formatParam(9, "pg")).toBe("$10")
  })

  it("formats mysql params as ?", () => {
    expect(formatParam(0, "mysql")).toBe("?")
    expect(formatParam(1, "mysql")).toBe("?")
    expect(formatParam(99, "mysql")).toBe("?")
  })

  it("formats sqlite params as ?", () => {
    expect(formatParam(0, "sqlite")).toBe("?")
    expect(formatParam(1, "sqlite")).toBe("?")
  })
})
