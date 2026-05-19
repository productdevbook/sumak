import type { CopyNode, CopyOptions } from "../../ast/ddl-nodes.ts"
import type { SelectNode } from "../../ast/nodes.ts"

/**
 * Surface used by {@link CopyToBuilder.query} — a builder-or-node value
 * that can produce a {@link SelectNode}. Matches the same "either a
 * builder or a raw node" shape used by `selectFromSubquery`, the CTE
 * factories, and a handful of other call sites.
 */
type SelectLike = SelectNode | { build(): SelectNode }

function unwrapSelect(input: SelectLike): SelectNode {
  return "build" in input ? input.build() : input
}

/**
 * Defensive copy of a {@link CopyOptions} bag — mutations on the
 * caller's source object must never bleed into a previously-built
 * node. Mirrors the per-builder array copies used elsewhere in the
 * DDL builder layer.
 */
function cloneOptions(opts: CopyOptions | undefined): CopyOptions | undefined {
  return opts ? { ...opts } : undefined
}

/**
 * Immutable builder for {@link CopyNode} in the bulk-import direction —
 * PostgreSQL `COPY <table> [(cols)] FROM STDIN [WITH (...)]`.
 *
 * The statement on its own only sets up the protocol-level COPY
 * channel; the actual row payload is streamed by the client driver
 * through the connection's COPY protocol message exchange. Sumak's
 * builder is concerned solely with emitting the statement itself —
 * driver-level COPY data streaming is the caller's job. The pglite
 * driver exposes the channel via `pg.query(sql).then(() => ...stream...)`
 * patterns; the standard `pg` driver exposes it via the `pg-copy-streams`
 * companion package. See `docs/recipes.md` for end-to-end snippets.
 *
 * Common shapes:
 *
 * ```ts
 * // Bare TEXT-format import (PG default — tabs between fields, \N for NULL).
 * copyFrom("users").build()
 *   // COPY "users" FROM STDIN
 *
 * // CSV import with a header row to skip.
 * copyFrom("users").csv().header().build()
 *   // COPY "users" FROM STDIN WITH (FORMAT csv, HEADER true)
 *
 * // Subset of columns, custom delimiter, custom NULL token.
 * copyFrom("users").columns("id", "name").delimiter("|").null("\\N").build()
 *   // COPY "users" ("id", "name") FROM STDIN WITH (DELIMITER '|', NULL '\N')
 * ```
 *
 * PG only. The DDL printer refuses on every non-PG dialect via the
 * `COPY_STMT` feature gate.
 */
export class CopyFromBuilder {
  private readonly node: CopyNode

  constructor(table: string)
  constructor(node: CopyNode)
  constructor(arg: string | CopyNode) {
    if (typeof arg === "string") {
      this.node = {
        type: "copy",
        direction: "from",
        source: "STDIN",
        table: { name: arg },
      }
    } else {
      // Defensive copy of nested arrays / option records so chained
      // calls on a copy of a previously-built node don't mutate the
      // caller's object graph.
      this.node = {
        ...arg,
        table: arg.table
          ? {
              name: arg.table.name,
              columns: arg.table.columns ? [...arg.table.columns] : undefined,
            }
          : undefined,
        options: cloneOptions(arg.options),
      }
    }
  }

  private clone(patch: Partial<CopyNode>): CopyFromBuilder {
    const next: CopyNode = {
      ...this.node,
      ...patch,
      // Re-copy nested mutables in case the patch reused our slots.
      table: patch.table
        ? {
            name: patch.table.name,
            columns: patch.table.columns ? [...patch.table.columns] : undefined,
          }
        : this.node.table
          ? {
              name: this.node.table.name,
              columns: this.node.table.columns ? [...this.node.table.columns] : undefined,
            }
          : undefined,
      options: patch.options ? cloneOptions(patch.options) : cloneOptions(this.node.options),
    }
    return new CopyFromBuilder(next)
  }

  private cloneWithOptions(patch: Partial<CopyOptions>): CopyFromBuilder {
    return this.clone({
      options: { ...this.node.options, ...patch },
    })
  }

  /**
   * Restrict the COPY to a subset of the table's columns. The argument
   * order is the order PG expects the values to appear in the data
   * stream — `("id", "name")` means each input row is `<id><sep><name>`.
   * Accepts either a rest list of column names or a single string array
   * (so callers can spread an already-built list). Replaces any
   * previously-set column list (the chain is idempotent).
   */
  columns(...args: [string[]] | string[]): CopyFromBuilder {
    const cols = args.length === 1 && Array.isArray(args[0]) ? [...args[0]] : (args as string[])
    return this.clone({
      table: this.node.table ? { ...this.node.table, columns: cols } : { name: "", columns: cols },
    })
  }

  /** `FORMAT csv` shortcut — equivalent to `.format("CSV")`. */
  csv(): CopyFromBuilder {
    return this.cloneWithOptions({ format: "CSV" })
  }

  /** `FORMAT binary` shortcut. The PG binary wire format is version-tied. */
  binary(): CopyFromBuilder {
    return this.cloneWithOptions({ format: "BINARY" })
  }

  /** `FORMAT text` shortcut — explicit PG default (tabs + `\N` for NULL). */
  text(): CopyFromBuilder {
    return this.cloneWithOptions({ format: "TEXT" })
  }

  /**
   * Set the format explicitly. Use when the format comes from config or
   * an RPC payload; prefer `.csv()` / `.binary()` / `.text()` shortcuts
   * when the value is known at the call site.
   */
  format(value: NonNullable<CopyOptions["format"]>): CopyFromBuilder {
    return this.cloneWithOptions({ format: value })
  }

  /**
   * `FREEZE` — mark the imported rows as frozen at load time, skipping
   * the eventual `VACUUM FREEZE`. PG requires the target table to have
   * been created or truncated in the same transaction; otherwise PG
   * raises at execution. Defaults to true; pass false to clear.
   */
  freeze(value = true): CopyFromBuilder {
    return this.cloneWithOptions({ freeze: value })
  }

  /**
   * `DELIMITER 'd'` — single-character field separator. The string is
   * escaped via `escapeStringLiteral` at print time so embedded quotes
   * can't break out of the literal.
   */
  delimiter(value: string): CopyFromBuilder {
    return this.cloneWithOptions({ delimiter: value })
  }

  /**
   * `NULL 'string'` — token representing a NULL value in the data
   * stream. Named with a trailing underscore to avoid the JS keyword;
   * call site reads `.null("\\N")`. The string is escaped via
   * `escapeStringLiteral` at print time.
   */
  null(value: string): CopyFromBuilder {
    return this.cloneWithOptions({ nullString: value })
  }

  /**
   * `HEADER [true|false|MATCH]`. The bare `.header()` form maps to
   * `HEADER true` (the common case — first input row is a header to
   * skip). The `MATCH` form (PG 12+) validates the first row's column
   * names against the column list and refuses the import on a
   * mismatch.
   */
  header(value: boolean | "match" | "MATCH" = true): CopyFromBuilder {
    const v = typeof value === "string" ? "MATCH" : value
    return this.cloneWithOptions({ header: v })
  }

  /** `QUOTE 'q'` — CSV-only at execution time. */
  quote(value: string): CopyFromBuilder {
    return this.cloneWithOptions({ quote: value })
  }

  /** `ESCAPE 'e'` — CSV-only at execution time. */
  escape(value: string): CopyFromBuilder {
    return this.cloneWithOptions({ escape: value })
  }

  /**
   * `ENCODING 'enc'` — transcode the data stream from `enc` to the
   * database's server_encoding on the way in.
   */
  encoding(value: string): CopyFromBuilder {
    return this.cloneWithOptions({ encoding: value })
  }

  build(): CopyNode {
    return {
      ...this.node,
      table: this.node.table
        ? {
            name: this.node.table.name,
            columns: this.node.table.columns ? [...this.node.table.columns] : undefined,
          }
        : undefined,
      options: cloneOptions(this.node.options),
    }
  }
}

/**
 * Immutable builder for {@link CopyNode} in the bulk-export direction —
 * PostgreSQL `COPY <table | (query)> TO STDOUT [WITH (...)]`.
 *
 * Two source shapes share the builder:
 *
 *  - **Table form** — `copyTo("users").build()` emits
 *    `COPY "users" TO STDOUT`. Optional column list via `.columns(...)`
 *    restricts the projection.
 *  - **Query form** — `copyTo("users").query(db.selectFrom("users")...)
 *    .build()` emits `COPY (SELECT ...) TO STDOUT`. The argument
 *    overrides the table source (PG accepts either form, never both).
 *    The embedded SELECT routes through the configured SELECT printer,
 *    so plugins / hooks / normalize / optimize all apply to the inner
 *    query the same way they do for `CREATE VIEW AS SELECT`.
 *
 * ```ts
 * // Plain export — every column, default format.
 * copyTo("users").build()
 *   // COPY "users" TO STDOUT
 *
 * // CSV with header row.
 * copyTo("users").csv().header().build()
 *   // COPY "users" TO STDOUT WITH (FORMAT csv, HEADER true)
 *
 * // Filtered export via the query form.
 * copyTo("users").query(db.selectFrom("users").where(...)).csv().build()
 *   // COPY (SELECT ... FROM "users" WHERE ...) TO STDOUT WITH (FORMAT csv)
 * ```
 *
 * PG only. The DDL printer refuses on every non-PG dialect via the
 * `COPY_STMT` feature gate.
 */
export class CopyToBuilder {
  private readonly node: CopyNode

  constructor(table: string)
  constructor(node: CopyNode)
  constructor(arg: string | CopyNode) {
    if (typeof arg === "string") {
      this.node = {
        type: "copy",
        direction: "to",
        source: "STDOUT",
        table: { name: arg },
      }
    } else {
      this.node = {
        ...arg,
        table: arg.table
          ? {
              name: arg.table.name,
              columns: arg.table.columns ? [...arg.table.columns] : undefined,
            }
          : undefined,
        options: cloneOptions(arg.options),
      }
    }
  }

  private clone(patch: Partial<CopyNode>): CopyToBuilder {
    const next: CopyNode = {
      ...this.node,
      ...patch,
      table:
        patch.table === null
          ? undefined
          : patch.table
            ? {
                name: patch.table.name,
                columns: patch.table.columns ? [...patch.table.columns] : undefined,
              }
            : this.node.table
              ? {
                  name: this.node.table.name,
                  columns: this.node.table.columns ? [...this.node.table.columns] : undefined,
                }
              : undefined,
      options: patch.options ? cloneOptions(patch.options) : cloneOptions(this.node.options),
    }
    return new CopyToBuilder(next)
  }

  private cloneWithOptions(patch: Partial<CopyOptions>): CopyToBuilder {
    return this.clone({
      options: { ...this.node.options, ...patch },
    })
  }

  /**
   * Restrict the COPY to a subset of the table's columns. Replaces any
   * previously-set list. Only meaningful in the table form — the
   * query form determines its own column list from the SELECT
   * projection. Calling `.columns()` *and* `.query()` is a builder-side
   * mistake; the printer refuses at compile time.
   */
  columns(...args: [string[]] | string[]): CopyToBuilder {
    const cols = args.length === 1 && Array.isArray(args[0]) ? [...args[0]] : (args as string[])
    return this.clone({
      table: this.node.table ? { ...this.node.table, columns: cols } : { name: "", columns: cols },
    })
  }

  /**
   * Switch the builder from the table form to the query form. Accepts
   * a `SelectBuilder` (or anything with a `.build(): SelectNode`) or a
   * raw `SelectNode`. After this call the table side is cleared — the
   * two forms are mutually exclusive.
   */
  query(select: SelectLike): CopyToBuilder {
    const node = unwrapSelect(select)
    return new CopyToBuilder({
      ...this.node,
      table: undefined,
      query: node,
      options: cloneOptions(this.node.options),
    })
  }

  /** `FORMAT csv` shortcut. */
  csv(): CopyToBuilder {
    return this.cloneWithOptions({ format: "CSV" })
  }

  /** `FORMAT binary` shortcut. */
  binary(): CopyToBuilder {
    return this.cloneWithOptions({ format: "BINARY" })
  }

  /** `FORMAT text` shortcut — explicit PG default. */
  text(): CopyToBuilder {
    return this.cloneWithOptions({ format: "TEXT" })
  }

  /** Set the format explicitly. */
  format(value: NonNullable<CopyOptions["format"]>): CopyToBuilder {
    return this.cloneWithOptions({ format: value })
  }

  /**
   * `DELIMITER 'd'` — single-character field separator. The string is
   * escaped via `escapeStringLiteral` at print time.
   */
  delimiter(value: string): CopyToBuilder {
    return this.cloneWithOptions({ delimiter: value })
  }

  /**
   * `NULL 'string'` — token representing a NULL value in the output
   * stream. Named with a trailing underscore to avoid the JS keyword.
   */
  null(value: string): CopyToBuilder {
    return this.cloneWithOptions({ nullString: value })
  }

  /**
   * `HEADER [true|false|MATCH]`. The bare `.header()` form maps to
   * `HEADER true` (emit a single header row first). `MATCH` is a
   * `COPY FROM`-only modifier; passing it on a `COPY TO` builder is
   * accepted at build time but rejected at print time so the failure
   * points back at the call site.
   */
  header(value: boolean | "match" | "MATCH" = true): CopyToBuilder {
    const v = typeof value === "string" ? "MATCH" : value
    return this.cloneWithOptions({ header: v })
  }

  /** `QUOTE 'q'` — CSV-only at execution time. */
  quote(value: string): CopyToBuilder {
    return this.cloneWithOptions({ quote: value })
  }

  /** `ESCAPE 'e'` — CSV-only at execution time. */
  escape(value: string): CopyToBuilder {
    return this.cloneWithOptions({ escape: value })
  }

  /**
   * `ENCODING 'enc'` — transcode the output stream to `enc` on the way
   * out.
   */
  encoding(value: string): CopyToBuilder {
    return this.cloneWithOptions({ encoding: value })
  }

  build(): CopyNode {
    return {
      ...this.node,
      table: this.node.table
        ? {
            name: this.node.table.name,
            columns: this.node.table.columns ? [...this.node.table.columns] : undefined,
          }
        : undefined,
      options: cloneOptions(this.node.options),
    }
  }
}

/**
 * Factory for {@link CopyFromBuilder} — bulk import direction.
 *
 * ```ts
 * copyFrom("users").csv().header().build()
 *   // COPY "users" FROM STDIN WITH (FORMAT csv, HEADER true)
 * ```
 */
export function copyFrom(table: string): CopyFromBuilder {
  return new CopyFromBuilder(table)
}

/**
 * Factory for {@link CopyToBuilder} — bulk export direction.
 *
 * ```ts
 * copyTo("users").csv().header().build()
 *   // COPY "users" TO STDOUT WITH (FORMAT csv, HEADER true)
 * ```
 */
export function copyTo(table: string): CopyToBuilder {
  return new CopyToBuilder(table)
}
