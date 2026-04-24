/**
 * A column as read from `information_schema` / driver metadata.
 *
 * sumak's introspection normalises the four dialects into this shared
 * shape before handing it to the schema-code generator. Values are
 * best-effort — not every dialect exposes every attribute, and anything
 * unknown is left undefined so the generator can emit the plain form.
 */
export interface IntrospectedColumn {
  /** Column name as the server reports it (already unquoted). */
  readonly name: string
  /**
   * Data type in sumak's vocabulary — already lowercased and normalised
   * (`serial`, `bigint`, `text`, `timestamptz`, …). The introspector for
   * each dialect does the dialect→sumak mapping; the generator emits
   * the corresponding column factory (`serial()`, `bigint()`, …).
   */
  readonly dataType: string
  readonly nullable: boolean
  readonly isPrimaryKey: boolean
  readonly isUnique: boolean
  readonly defaultExpression?: string
  readonly references?: {
    readonly table: string
    readonly column: string
    readonly onDelete?: string
    readonly onUpdate?: string
  }
}

/**
 * Table-level constraints the introspector was able to recover. Columns
 * carry their own `isPrimaryKey` / `isUnique` flags for the common
 * single-column shapes, but composite keys, named CHECKs, and named /
 * composite FKs only make sense at table scope — they land here.
 */
export interface IntrospectedConstraints {
  readonly primaryKey?: { readonly name?: string; readonly columns: readonly string[] }
  readonly uniques?: ReadonlyArray<{ readonly name?: string; readonly columns: readonly string[] }>
  readonly checks?: ReadonlyArray<{ readonly name?: string; readonly expression: string }>
  readonly foreignKeys?: ReadonlyArray<{
    readonly name?: string
    readonly columns: readonly string[]
    readonly references: { readonly table: string; readonly columns: readonly string[] }
    readonly onDelete?: string
    readonly onUpdate?: string
  }>
}

/**
 * Named index as read from the catalog. Primary-key and
 * UNIQUE-constraint indexes are filtered out — they round-trip via
 * {@link IntrospectedConstraints} instead, and re-emitting them here
 * would create duplicates when diffed against the schema they came
 * from.
 */
export interface IntrospectedIndex {
  readonly name: string
  readonly columns: readonly string[]
  readonly unique: boolean
  readonly using?: string
  readonly where?: string
}

export interface IntrospectedTable {
  readonly name: string
  readonly schema?: string
  readonly columns: readonly IntrospectedColumn[]
  readonly constraints?: IntrospectedConstraints
  readonly indexes?: readonly IntrospectedIndex[]
}

export interface IntrospectedSchema {
  readonly dialect: "pg" | "mysql" | "sqlite" | "mssql"
  readonly tables: readonly IntrospectedTable[]
}
