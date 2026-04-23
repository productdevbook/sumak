import type { IntrospectedColumn, IntrospectedSchema } from "./types.ts"

/**
 * Options for {@link generateSchemaCode}.
 */
export interface GenerateOptions {
  /** Name of the exported const. Defaults to `tables`. */
  readonly varName?: string
  /** Preface every line with this many spaces. Defaults to 0. */
  readonly indent?: number
  /** Emit `import { … } from "sumak/schema"` at the top. Default: true. */
  readonly includeImport?: boolean
}

/**
 * Emit TypeScript source code for a sumak `tables` object equivalent
 * to the introspected schema. The output is meant to be written to a
 * file and committed — it's the schema-as-code mirror of what's
 * currently in the database.
 *
 * Supported in the output:
 *  - Column factory per known data type (`serial()`, `text()`, …).
 *  - Modifiers: `.primaryKey()`, `.notNull()`, `.nullable()`, `.unique()`,
 *    `.references(table, column)`.
 *
 * Not yet supported (emitted as a comment `// TODO:` next to the column):
 *  - DEFAULT expressions — the introspector captures the raw SQL, but
 *    mapping arbitrary PG expressions back to typed sumak builders
 *    isn't on this code path yet.
 *  - CHECK constraints and composite primary keys.
 */
export function generateSchemaCode(schema: IntrospectedSchema, opts: GenerateOptions = {}): string {
  const varName = opts.varName ?? "tables"
  const indent = " ".repeat(opts.indent ?? 0)
  const includeImport = opts.includeImport ?? true

  const usedFactories = new Set<string>()
  const tableBlocks: string[] = []

  for (const t of schema.tables) {
    const lines: string[] = []
    lines.push(`${indent}  ${identifier(t.name)}: {`)
    for (const c of t.columns) {
      const { code, factory } = renderColumn(c)
      usedFactories.add(factory)
      lines.push(`${indent}    ${identifier(c.name)}: ${code},`)
    }
    lines.push(`${indent}  },`)
    tableBlocks.push(lines.join("\n"))
  }

  const factories = [...usedFactories].sort()
  const importLine = includeImport
    ? `import { ${factories.join(", ")} } from "sumak/schema"\n\n`
    : ""

  return (
    `${importLine}${indent}export const ${varName} = {\n` +
    `${tableBlocks.join("\n")}\n` +
    `${indent}} as const\n`
  )
}

function renderColumn(c: IntrospectedColumn): { code: string; factory: string } {
  const factory = c.dataType
  const parts: string[] = [`${factory}()`]
  if (c.isPrimaryKey) parts.push(".primaryKey()")
  if (c.isUnique && !c.isPrimaryKey) parts.push(".unique()")
  if (c.nullable) {
    parts.push(".nullable()")
  } else if (!c.isPrimaryKey) {
    parts.push(".notNull()")
  }
  if (c.references) {
    parts.push(`.references("${c.references.table}", "${c.references.column}")`)
    if (c.references.onDelete && c.references.onDelete !== "NO ACTION") {
      parts.push(`.onDelete("${c.references.onDelete}")`)
    }
  }
  return { code: parts.join(""), factory }
}

/**
 * Emit the column name as a safe object key. Plain identifiers go
 * unquoted; anything with a hyphen, space, or reserved char gets
 * wrapped in double quotes.
 */
function identifier(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : JSON.stringify(name)
}
