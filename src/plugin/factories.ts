import { AuditTimestampPlugin } from "./audit-timestamp.ts"
import { CamelCasePlugin } from "./camel-case.ts"
import { DataMaskingPlugin } from "./data-masking.ts"
import { MultiTenantPlugin } from "./multi-tenant.ts"
import { OptimisticLockPlugin } from "./optimistic-lock.ts"
import { QueryLimitPlugin } from "./query-limit.ts"
import { SoftDeletePlugin } from "./soft-delete.ts"
import type { SumakPlugin } from "./types.ts"
import { WithSchemaPlugin } from "./with-schema.ts"

/**
 * Factory functions for every built-in plugin.
 *
 * These wrap the underlying plugin classes so you don't need `new`, can pass
 * options as plain objects, and get better tree-shaking.
 *
 * ```ts
 * import { sumak, softDelete, audit, multiTenant } from "sumak"
 *
 * const db = sumak({
 *   dialect: pgDialect(),
 *   plugins: [
 *     softDelete({ tables: ["users"], mode: "convert" }),
 *     audit({ tables: ["users"] }),
 *     multiTenant({ tables: ["users"], tenantId: () => ctx.tenantId }),
 *   ],
 *   tables: { ... },
 * })
 * ```
 */

export function softDelete(config: ConstructorParameters<typeof SoftDeletePlugin>[0]): SumakPlugin {
  return new SoftDeletePlugin(config)
}

export function audit(config: ConstructorParameters<typeof AuditTimestampPlugin>[0]): SumakPlugin {
  return new AuditTimestampPlugin(config)
}

export function multiTenant(
  config: ConstructorParameters<typeof MultiTenantPlugin>[0],
): SumakPlugin {
  return new MultiTenantPlugin(config)
}

export function queryLimit(
  config?: ConstructorParameters<typeof QueryLimitPlugin>[0],
): SumakPlugin {
  return new QueryLimitPlugin(config)
}

export function withSchema(schema: string): SumakPlugin {
  return new WithSchemaPlugin(schema)
}

export function camelCase(): SumakPlugin {
  return new CamelCasePlugin()
}

export function optimisticLock(
  config: ConstructorParameters<typeof OptimisticLockPlugin>[0],
): SumakPlugin {
  return new OptimisticLockPlugin(config)
}

export function dataMasking(
  config: ConstructorParameters<typeof DataMaskingPlugin>[0],
): SumakPlugin {
  return new DataMaskingPlugin(config)
}
