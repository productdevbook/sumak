import { describe, expect, it } from "vitest"

import { DataMaskingPlugin } from "../../src/plugin/data-masking.ts"

describe("DataMaskingPlugin", () => {
  it("masks email", () => {
    const plugin = new DataMaskingPlugin({
      rules: [{ column: "email", mask: "email" }],
    })
    const result = plugin.transformResult!([
      { id: 1, email: "alice@example.com" },
      { id: 2, email: "bob@test.org" },
    ])
    expect(result[0]!.email).toBe("al***@example.com")
    expect(result[1]!.email).toBe("bo***@test.org")
  })

  it("masks phone", () => {
    const plugin = new DataMaskingPlugin({
      rules: [{ column: "phone", mask: "phone" }],
    })
    const result = plugin.transformResult!([{ id: 1, phone: "+1234567890" }])
    expect(result[0]!.phone).toBe("***7890")
  })

  it("masks partial", () => {
    const plugin = new DataMaskingPlugin({
      rules: [{ column: "name", mask: "partial" }],
    })
    const result = plugin.transformResult!([{ id: 1, name: "John Doe" }])
    expect(result[0]!.name).toBe("Jo***")
  })

  it("custom mask function", () => {
    const plugin = new DataMaskingPlugin({
      rules: [{ column: "ssn", mask: (v) => `***-**-${String(v).slice(-4)}` }],
    })
    const result = plugin.transformResult!([{ id: 1, ssn: "123-45-6789" }])
    expect(result[0]!.ssn).toBe("***-**-6789")
  })

  it("leaves non-configured columns untouched", () => {
    const plugin = new DataMaskingPlugin({
      rules: [{ column: "email", mask: "email" }],
    })
    const result = plugin.transformResult!([{ id: 1, email: "a@b.com", name: "Alice" }])
    expect(result[0]!.name).toBe("Alice")
    expect(result[0]!.id).toBe(1)
  })

  it("handles null/undefined values", () => {
    const plugin = new DataMaskingPlugin({
      rules: [{ column: "email", mask: "email" }],
    })
    const result = plugin.transformResult!([
      { id: 1, email: null },
      { id: 2, email: undefined },
    ])
    expect(result[0]!.email).toBeNull()
    expect(result[1]!.email).toBeUndefined()
  })

  it("multiple rules on different columns", () => {
    const plugin = new DataMaskingPlugin({
      rules: [
        { column: "email", mask: "email" },
        { column: "phone", mask: "phone" },
      ],
    })
    const result = plugin.transformResult!([
      { id: 1, email: "alice@test.com", phone: "+1234567890" },
    ])
    expect(result[0]!.email).toBe("al***@test.com")
    expect(result[0]!.phone).toBe("***7890")
  })

  it("short email keeps structure", () => {
    const plugin = new DataMaskingPlugin({
      rules: [{ column: "email", mask: "email" }],
    })
    const result = plugin.transformResult!([{ id: 1, email: "a@b.com" }])
    expect(result[0]!.email).toContain("@b.com")
  })
})
