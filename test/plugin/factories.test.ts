import { describe, expect, it } from "vitest"

import {
  audit,
  camelCase,
  dataMasking,
  multiTenant,
  optimisticLock,
  queryLimit,
  softDelete,
  withSchema,
} from "../../src/index.ts"
import { AuditTimestampPlugin } from "../../src/plugin/audit-timestamp.ts"
import { CamelCasePlugin } from "../../src/plugin/camel-case.ts"
import { DataMaskingPlugin } from "../../src/plugin/data-masking.ts"
import { MultiTenantPlugin } from "../../src/plugin/multi-tenant.ts"
import { OptimisticLockPlugin } from "../../src/plugin/optimistic-lock.ts"
import { QueryLimitPlugin } from "../../src/plugin/query-limit.ts"
import { SoftDeletePlugin } from "../../src/plugin/soft-delete.ts"
import { WithSchemaPlugin } from "../../src/plugin/with-schema.ts"

describe("plugin factories — v0.1 API", () => {
  it("softDelete() returns a SoftDeletePlugin-shaped instance", () => {
    const p = softDelete({ tables: ["users"], mode: "convert" })
    expect(p).toBeInstanceOf(SoftDeletePlugin)
    expect(p.name).toBe("soft-delete")
  })

  it("audit() returns an AuditTimestampPlugin-shaped instance", () => {
    const p = audit({ tables: ["users"] })
    expect(p).toBeInstanceOf(AuditTimestampPlugin)
    expect(p.name).toBe("audit-timestamp")
  })

  it("multiTenant() — with callback tenantId", () => {
    const p = multiTenant({ tables: ["users"], tenantId: () => "t1" })
    expect(p).toBeInstanceOf(MultiTenantPlugin)
  })

  it("queryLimit() — default maxRows", () => {
    const p = queryLimit()
    expect(p).toBeInstanceOf(QueryLimitPlugin)
  })

  it("queryLimit({ maxRows: 500 })", () => {
    const p = queryLimit({ maxRows: 500 })
    expect(p).toBeInstanceOf(QueryLimitPlugin)
  })

  it("withSchema('public') returns a WithSchemaPlugin", () => {
    const p = withSchema("public")
    expect(p).toBeInstanceOf(WithSchemaPlugin)
  })

  it("camelCase() is the CamelCasePlugin", () => {
    const p = camelCase()
    expect(p).toBeInstanceOf(CamelCasePlugin)
  })

  it("optimisticLock() with callback", () => {
    let v = 1
    const p = optimisticLock({ tables: ["users"], currentVersion: () => v })
    expect(p).toBeInstanceOf(OptimisticLockPlugin)
    v++
  })

  it("dataMasking({ rules })", () => {
    const p = dataMasking({ rules: [{ column: "email", mask: "email" }] })
    expect(p).toBeInstanceOf(DataMaskingPlugin)
  })
})
