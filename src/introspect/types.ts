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

export interface IntrospectedTable {
  readonly name: string
  readonly schema?: string
  readonly columns: readonly IntrospectedColumn[]
}

export interface IntrospectedSchema {
  readonly dialect: "pg" | "mysql" | "sqlite" | "mssql"
  readonly tables: readonly IntrospectedTable[]
}
