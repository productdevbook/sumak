import { describe, expect, it } from "vitest"

import { CamelCasePlugin } from "../../src/plugin/camel-case.ts"

describe("CamelCasePlugin", () => {
  const plugin = new CamelCasePlugin()

  it("converts snake_case keys to camelCase", () => {
    const rows = [{ first_name: "Alice", last_name: "Smith", user_id: 1 }]
    const result = plugin.transformResult!(rows)
    expect(result[0]).toEqual({
      firstName: "Alice",
      lastName: "Smith",
      userId: 1,
    })
  })

  it("handles already camelCase keys", () => {
    const rows = [{ name: "Bob", email: "bob@test.com" }]
    const result = plugin.transformResult!(rows)
    expect(result[0]).toEqual({ name: "Bob", email: "bob@test.com" })
  })

  it("handles multiple rows", () => {
    const rows = [{ user_name: "Alice" }, { user_name: "Bob" }]
    const result = plugin.transformResult!(rows)
    expect(result).toEqual([{ userName: "Alice" }, { userName: "Bob" }])
  })

  it("handles empty rows", () => {
    expect(plugin.transformResult!([])).toEqual([])
  })

  it("handles multiple underscores", () => {
    const rows = [{ created_at_utc: "2026-01-01" }]
    const result = plugin.transformResult!(rows)
    expect(result[0]).toEqual({ createdAtUtc: "2026-01-01" })
  })
})
