import type { SumakPlugin } from "./types.ts"

type MaskFunction = (value: unknown) => unknown

interface DataMaskingConfig {
  rules: {
    column: string
    mask: MaskFunction | "email" | "phone" | "partial"
  }[]
}

function maskEmail(value: unknown): unknown {
  if (typeof value !== "string") return value
  const atIndex = value.indexOf("@")
  if (atIndex < 0) return value
  const local = value.slice(0, atIndex)
  const domain = value.slice(atIndex)
  const keep = local.slice(0, 2)
  return `${keep}***${domain}`
}

function maskPhone(value: unknown): unknown {
  if (typeof value !== "string") return value
  const last4 = value.slice(-4)
  return `***${last4}`
}

function maskPartial(value: unknown): unknown {
  if (typeof value !== "string") return value
  const keep = value.slice(0, 2)
  return `${keep}***`
}

const builtinMasks: Record<string, MaskFunction> = {
  email: maskEmail,
  phone: maskPhone,
  partial: maskPartial,
}

/**
 * Result-transform plugin that masks sensitive data in query results.
 *
 * Supports built-in mask types (`"email"`, `"phone"`, `"partial"`) and
 * custom mask functions.
 *
 * ```ts
 * const plugin = new DataMaskingPlugin({
 *   rules: [
 *     { column: "email", mask: "email" },
 *     { column: "phone", mask: "phone" },
 *     { column: "name", mask: "partial" },
 *   ],
 * })
 * ```
 */
export class DataMaskingPlugin implements SumakPlugin {
  readonly name = "data-masking"
  private rules: Map<string, MaskFunction>

  constructor(config: DataMaskingConfig) {
    this.rules = new Map()
    for (const rule of config.rules) {
      const fn = typeof rule.mask === "string" ? builtinMasks[rule.mask] : rule.mask
      if (fn) {
        this.rules.set(rule.column, fn)
      }
    }
  }

  transformResult(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    return rows.map((row) => {
      const masked = { ...row }
      for (const [column, fn] of this.rules) {
        if (column in masked) {
          masked[column] = fn(masked[column])
        }
      }
      return masked
    })
  }
}
