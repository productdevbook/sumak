import type { CreateFunctionNode, DropFunctionNode, FunctionArg } from "../../ast/ddl-nodes.ts"
import type { ExpressionNode } from "../../ast/nodes.ts"
import type { Expression } from "../../ast/typed-expression.ts"
import { brandExpression } from "../../ast/typed-expression.ts"

/**
 * Map a SQL type name (lower-cased, base type only) to its closest
 * TypeScript equivalent. The lookup happens at the type level via a
 * template-literal/conditional mapped type — see {@link SqlToTs}.
 *
 * The table is intentionally narrow: the four common scalar buckets
 * (`number`, `string`, `boolean`, `Date`) plus a fallback to
 * `unknown`. Engine-specific or composite types (UUID, JSONB, arrays,
 * ranges, …) fall through to `unknown`, which forces the caller to be
 * explicit via the `Args` / `Ret` generic slots if they want a sharper
 * type at the call site.
 *
 * The mapping is keyed off the lower-cased *first word* of the SQL
 * type string — `"numeric(10, 2)"`, `"NUMERIC"`, `"Numeric"`, and
 * `"numeric"` all resolve to `number`. Precision / scale / array
 * suffixes are stripped by {@link BaseSqlType}.
 */
type Lowercase2<S extends string> = Lowercase<S>

type BaseSqlType<S extends string> =
  Lowercase2<S> extends `${infer Head}(${string}`
    ? Lowercase2<Head> extends `${infer Trimmed} `
      ? Trimmed
      : Lowercase2<Head>
    : Lowercase2<S> extends `${infer Head} ${string}`
      ? Head
      : Lowercase2<S>

/**
 * Numeric SQL type names — every dialect-portable family that maps
 * cleanly to `number`. `serial` / `bigserial` are PG-only auto-
 * increment shorthands but they're numeric on the JS side, so they
 * map here too.
 */
type NumericSqlType =
  | "smallint"
  | "integer"
  | "int"
  | "int2"
  | "int4"
  | "int8"
  | "bigint"
  | "decimal"
  | "numeric"
  | "real"
  | "double precision"
  | "float"
  | "float4"
  | "float8"
  | "serial"
  | "bigserial"
  | "smallserial"

type StringSqlType =
  | "text"
  | "varchar"
  | "char"
  | "character"
  | "character varying"
  | "citext"
  | "uuid"
  | "name"

type BooleanSqlType = "boolean" | "bool"

type DateSqlType =
  | "date"
  | "timestamp"
  | "timestamptz"
  | "timestamp with time zone"
  | "timestamp without time zone"
  | "time"
  | "timetz"

/**
 * Translate a SQL type string into the matching TS scalar. Unknown
 * types resolve to `unknown` so the caller stays in control via the
 * explicit `Args` / `Ret` generics on `arg<T>()` / `.returns<T>()`.
 */
export type SqlToTs<S extends string> =
  BaseSqlType<S> extends NumericSqlType
    ? number
    : BaseSqlType<S> extends StringSqlType
      ? string
      : BaseSqlType<S> extends BooleanSqlType
        ? boolean
        : BaseSqlType<S> extends DateSqlType
          ? Date
          : unknown

/**
 * Partial `FunctionArg` carrying the SQL type plus optional default /
 * mode. The arg name is filled in by `.args({ name: arg(...) })`.
 *
 * The `__ts` phantom slot lets us round-trip a caller-supplied TS
 * type — `arg<MyType>("numeric")` overrides the default `SqlToTs<"numeric">`
 * mapping when the caller wants a sharper or branded type.
 */
export interface FunctionArgSpec<T = unknown, S extends string = string> {
  readonly __ts?: T
  readonly type: S
  readonly defaultValue?: ExpressionNode
  readonly mode?: FunctionArg["mode"]
}

/**
 * Build one entry in a `CREATE FUNCTION` arg list.
 *
 * ```ts
 * arg("numeric")
 * arg("numeric", { default: val(0.2) })
 * arg("integer", { mode: "INOUT" })
 * arg<MyBrand>("text")
 * ```
 *
 * `T` defaults to the {@link SqlToTs} mapping of `sqlType` — pass an
 * explicit generic to override.
 */
export function arg<S extends string, T = unknown>(
  sqlType: S,
  opts: { default?: ExpressionNode | Expression<unknown>; mode?: FunctionArg["mode"] } = {},
): FunctionArgSpec<T, S> {
  const def = opts.default
  // Accept either a raw AST node or an Expression wrapper. We accept
  // `Expression<unknown>` rather than `Expression<T>` so the caller
  // can use `val(0.2)` even when T is `unknown` (the inference path).
  const defaultValue =
    def === undefined
      ? undefined
      : typeof def === "object" && def !== null && "node" in (def as { node?: unknown })
        ? (def as { node: ExpressionNode }).node
        : (def as ExpressionNode)
  return { type: sqlType, defaultValue, mode: opts.mode }
}

/**
 * Extract the TS type out of an arg spec, defaulting to
 * {@link SqlToTs} when the caller didn't supply an explicit generic.
 *
 * The conditional checks for the phantom `__ts` slot — when present
 * (caller wrote `arg<X>(...)`) we surface X; otherwise we fall back to
 * the SQL-string mapping.
 */
type ArgTs<S extends FunctionArgSpec> = S extends { __ts?: infer T }
  ? unknown extends T
    ? S extends { type: infer Ty extends string }
      ? SqlToTs<Ty>
      : unknown
    : T
  : unknown

/**
 * Map an args-spec object to `{ name: TS-type, … }`. The output is
 * what `.body(callback)` receives as `{ [K]: Expression<…> }` and what
 * `.call(args)` accepts as `{ [K]: Expression<…> | …}`.
 */
type ArgsMap<A extends Record<string, FunctionArgSpec>> = {
  [K in keyof A]: ArgTs<A[K]>
}

/**
 * The value returned from `CreateFunctionBuilder.build()`. Carries the
 * underlying DDL node *and* a typed `.call(...)` method that produces
 * `Expression<Ret>` referencing the function by name, with arguments
 * type-checked against the declared signature.
 *
 * ```ts
 * const taxes = pg.schema.createFunction("compute_taxes")
 *   .args({ price: arg("numeric"), tax: arg("numeric") })
 *   .returns("numeric")
 *   .languageSql()
 *   .body(({ price, tax }) => mul(price, add(val(1), tax)))
 *   .build()
 *
 * // taxes.node — the CreateFunctionNode (feed to db.compileDDL)
 * // taxes.call({ price: typedCol("price"), tax: val(0.18) })
 * //   → Expression<number>
 * ```
 */
export interface TypedFunction<Args extends Record<string, unknown>, Ret> {
  readonly node: CreateFunctionNode
  call(args: { [K in keyof Args]: Expression<Args[K]> | Args[K] }): Expression<Ret>
}

const EMPTY_ARGS: Record<string, FunctionArgSpec> = {}

/**
 * Builder for {@link CreateFunctionNode} — PostgreSQL `CREATE FUNCTION`
 * with a typed expression body (ADR 005 Phase 1).
 *
 * The shape is fluent and *immutable* — every method returns a fresh
 * builder so chains can branch without cross-pollution. The generics
 * `Args` and `Ret` get refined by `.args(...)` and `.returns(...)` so
 * the `.body(...)` callback and the `.build().call(...)` site share
 * one source of type truth.
 *
 * ```ts
 * const taxes = pg.schema.createFunction("compute_taxes")
 *   .args({ price: arg("numeric"), tax: arg("numeric", { default: val(0.2) }) })
 *   .returns("numeric")
 *   .languageSql()
 *   .body(({ price, tax }) => mul(price, add(val(1), tax)))
 *   .build()
 * ```
 *
 * PostgreSQL only — the DDL printer refuses on MySQL / SQLite / MSSQL
 * via the `CREATE_FUNCTION` feature gate.
 */
export class CreateFunctionBuilder<
  Args extends Record<string, FunctionArgSpec> = Record<string, never>,
  Ret = unknown,
> {
  private readonly _name: string
  private readonly _schema?: string
  private readonly _orReplace: boolean
  private readonly _args: Args
  private readonly _returns?: string
  private readonly _language?: "sql" | "plpgsql"
  private readonly _body?: ExpressionNode
  private readonly _immutable?: boolean
  private readonly _stable?: boolean
  private readonly _strict?: boolean
  private readonly _parallel?: "safe" | "restricted" | "unsafe"
  private readonly _security?: "definer" | "invoker"

  constructor(name: string, schema?: string)
  constructor(state: {
    name: string
    schema?: string
    orReplace: boolean
    args: Args
    returns?: string
    language?: "sql" | "plpgsql"
    body?: ExpressionNode
    immutable?: boolean
    stable?: boolean
    strict?: boolean
    parallel?: "safe" | "restricted" | "unsafe"
    security?: "definer" | "invoker"
  })
  constructor(
    arg1:
      | string
      | {
          name: string
          schema?: string
          orReplace: boolean
          args: Args
          returns?: string
          language?: "sql" | "plpgsql"
          body?: ExpressionNode
          immutable?: boolean
          stable?: boolean
          strict?: boolean
          parallel?: "safe" | "restricted" | "unsafe"
          security?: "definer" | "invoker"
        },
    schema?: string,
  ) {
    if (typeof arg1 === "string") {
      this._name = arg1
      this._schema = schema
      this._orReplace = false
      this._args = EMPTY_ARGS as Args
    } else {
      this._name = arg1.name
      this._schema = arg1.schema
      this._orReplace = arg1.orReplace
      this._args = arg1.args
      this._returns = arg1.returns
      this._language = arg1.language
      this._body = arg1.body
      this._immutable = arg1.immutable
      this._stable = arg1.stable
      this._strict = arg1.strict
      this._parallel = arg1.parallel
      this._security = arg1.security
    }
  }

  private cloneWith<A2 extends Record<string, FunctionArgSpec>, R2>(
    patch: Partial<{
      args: A2
      returns: string
      language: "sql" | "plpgsql"
      body: ExpressionNode
      orReplace: boolean
      immutable: boolean
      stable: boolean
      strict: boolean
      parallel: "safe" | "restricted" | "unsafe"
      security: "definer" | "invoker"
    }>,
  ): CreateFunctionBuilder<A2, R2> {
    return new CreateFunctionBuilder<A2, R2>({
      name: this._name,
      schema: this._schema,
      orReplace: patch.orReplace ?? this._orReplace,
      args: patch.args ?? (this._args as unknown as A2),
      returns: patch.returns ?? this._returns,
      language: patch.language ?? this._language,
      body: patch.body ?? this._body,
      immutable: patch.immutable ?? this._immutable,
      stable: patch.stable ?? this._stable,
      strict: patch.strict ?? this._strict,
      parallel: patch.parallel ?? this._parallel,
      security: patch.security ?? this._security,
    })
  }

  /** `CREATE OR REPLACE FUNCTION` — replace an existing function with
   * the same name and signature. PG refuses to replace if the return
   * type changes; that's a server-side error rather than a builder
   * concern. */
  orReplace(): CreateFunctionBuilder<Args, Ret> {
    return this.cloneWith({ orReplace: true })
  }

  /**
   * Declare the function's argument list. Each entry's value is an
   * {@link arg} call (or a hand-rolled `FunctionArgSpec`). The args
   * map drives both the printed `(name type[, …])` parameter list
   * **and** the typed shape of `.body(callback)` and the resulting
   * `.call(...)` method.
   *
   * Calling `.args(...)` twice replaces the previous declaration. The
   * order of properties in the object literal determines the emitted
   * parameter order — TypeScript preserves insertion order on object
   * literals so this round-trips reliably.
   */
  args<A extends Record<string, FunctionArgSpec>>(args: A): CreateFunctionBuilder<A, Ret> {
    return this.cloneWith<A, Ret>({ args })
  }

  /**
   * Declare the return type. The SQL type string maps to a TS scalar
   * via {@link SqlToTs}; pass an explicit `<R2>` generic to override
   * the default mapping (e.g. for a branded type or a `Date`-mapped
   * "interval").
   */
  returns<S extends string, R2 = SqlToTs<S>>(sqlType: S): CreateFunctionBuilder<Args, R2> {
    return this.cloneWith<Args, R2>({ returns: sqlType })
  }

  /** `LANGUAGE sql` — body emitted as `AS $$ SELECT <expr> $$`. */
  languageSql(): CreateFunctionBuilder<Args, Ret> {
    return this.cloneWith({ language: "sql" })
  }

  /** `LANGUAGE plpgsql` — body emitted as `AS $$ BEGIN RETURN <expr>; END $$`. */
  languagePlpgsql(): CreateFunctionBuilder<Args, Ret> {
    return this.cloneWith({ language: "plpgsql" })
  }

  /** Mark as `IMMUTABLE`. Mutually exclusive with {@link stable}. */
  immutable(): CreateFunctionBuilder<Args, Ret> {
    return this.cloneWith({ immutable: true, stable: false })
  }

  /** Mark as `STABLE`. Mutually exclusive with {@link immutable}. */
  stable(): CreateFunctionBuilder<Args, Ret> {
    return this.cloneWith({ stable: true, immutable: false })
  }

  /** Mark as `STRICT` (returns NULL when any arg is NULL). */
  strict(): CreateFunctionBuilder<Args, Ret> {
    return this.cloneWith({ strict: true })
  }

  /** `PARALLEL safe | restricted | unsafe`. */
  parallel(mode: "safe" | "restricted" | "unsafe"): CreateFunctionBuilder<Args, Ret> {
    return this.cloneWith({ parallel: mode })
  }

  /** `SECURITY DEFINER | INVOKER`. Default is `INVOKER` (PG default
   * when omitted), so passing `"invoker"` here is rarely useful — it
   * exists for round-trip with the AST node and explicit emission. */
  security(mode: "definer" | "invoker"): CreateFunctionBuilder<Args, Ret> {
    return this.cloneWith({ security: mode })
  }

  /**
   * Supply the function body as a callback that receives the typed
   * args map. The callback's return is an `Expression<Ret>` — either a
   * branded Expression wrapper (from `val(...)`, `typedCol(...)`,
   * `add(...)`, another typed function's `.call(...)`, etc.) or a raw
   * `ExpressionNode`.
   */
  body(
    callback: (args: { [K in keyof Args]: Expression<ArgTs<Args[K]>> }) =>
      | Expression<Ret>
      | ExpressionNode,
  ): CreateFunctionBuilder<Args, Ret> {
    const argExprs = {} as { [K in keyof Args]: Expression<ArgTs<Args[K]>> }
    for (const key of Object.keys(this._args)) {
      argExprs[key as keyof Args] = brandExpression({
        type: "column_ref",
        column: key,
      }) as Expression<ArgTs<Args[typeof key]>>
    }
    const result = callback(argExprs)
    const bodyNode = unwrapMaybeExpression(result)
    return this.cloneWith({ body: bodyNode })
  }

  /** The accumulated `CreateFunctionNode`. Useful for tests and tooling
   * that want to inspect the AST without compiling. */
  buildNode(): CreateFunctionNode {
    if (this._returns === undefined) {
      throw new Error(
        `CREATE FUNCTION "${this._name}": .returns(<type>) is required before .build().`,
      )
    }
    if (this._language === undefined) {
      throw new Error(
        `CREATE FUNCTION "${this._name}": .languageSql() or .languagePlpgsql() is required before .build().`,
      )
    }
    if (this._body === undefined) {
      throw new Error(
        `CREATE FUNCTION "${this._name}": .body(callback) is required before .build().`,
      )
    }
    const argList: FunctionArg[] = []
    for (const [name, spec] of Object.entries(this._args)) {
      argList.push({
        name,
        type: spec.type,
        defaultValue: spec.defaultValue,
        mode: spec.mode,
      })
    }
    return {
      type: "create_function",
      name: this._name,
      schema: this._schema,
      orReplace: this._orReplace || undefined,
      args: argList,
      returns: this._returns,
      language: this._language,
      body: this._body,
      immutable: this._immutable,
      stable: this._stable,
      strict: this._strict,
      parallel: this._parallel,
      security: this._security,
    }
  }

  /**
   * Materialize the function as a {@link TypedFunction} carrying the
   * AST node *and* a typed `.call(...)` method. The call method
   * produces `Expression<Ret>` referencing the function by name.
   */
  build(): TypedFunction<ArgsMap<Args>, Ret> {
    const node = this.buildNode()
    const name = this._name
    const schema = this._schema
    const argOrder = Object.keys(this._args) as (keyof Args)[]

    return {
      node,
      call(callArgs) {
        const argNodes: ExpressionNode[] = []
        for (const key of argOrder) {
          const v = callArgs[key as keyof typeof callArgs]
          if (v === undefined) {
            // Allow missing if the original spec had a default; emit
            // nothing for that slot (PG fills in the DEFAULT). PG's
            // positional defaulting rule: trailing-defaults only —
            // once you skip one, you can't supply later ones. We
            // simply omit and let PG report any positional issues.
            continue
          }
          argNodes.push(toExpressionNode(v))
        }
        const callNode: ExpressionNode = {
          type: "function_call",
          // Schema-qualified function names are rare in practice; when
          // present we emit `"schema"."name"(args)` via the prefixed
          // string the printer accepts. The printer validates the
          // function name through `validateFunctionName`, so we keep
          // the bare-name path here and pass schema via the node's
          // `name` slot only when set. For Phase 1 we keep `.call()`
          // schema-less — schema-qualified callers can manually build
          // the AST.
          name: schema ? `${quoteIdent(schema)}.${quoteIdent(name)}` : name,
          args: argNodes,
        }
        return brandExpression(callNode)
      },
    }
  }
}

/** Local copy of identifier quoting — DDL printer's `quoteIdentifier`
 * lives behind the dialect parameter. Function-name quoting from a
 * schema prefix uses the PG/SQLite double-quote shape, which matches
 * the only dialect that supports CREATE FUNCTION in Phase 1. */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

function unwrapMaybeExpression(value: Expression<unknown> | ExpressionNode): ExpressionNode {
  if (
    typeof value === "object" &&
    value !== null &&
    "node" in (value as { node?: unknown }) &&
    typeof (value as { node?: unknown }).node === "object" &&
    (value as { node: unknown }).node !== null
  ) {
    return (value as Expression<unknown>).node
  }
  return value as ExpressionNode
}

function toExpressionNode(value: Expression<unknown> | unknown): ExpressionNode {
  if (
    typeof value === "object" &&
    value !== null &&
    "node" in (value as { node?: unknown }) &&
    typeof (value as { node?: unknown }).node === "object" &&
    (value as { node: unknown }).node !== null
  ) {
    return (value as Expression<unknown>).node
  }
  // Auto-wrap a primitive — the same convenience the typed select /
  // insert APIs offer. Strings, numbers, booleans, and `null` go in
  // as literals; we deliberately don't param-bind here because the
  // function-body / function-call slot may live anywhere in DDL.
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return { type: "literal", value }
  }
  throw new TypeError(
    `Function .call(): unsupported argument value of type ${typeof value}. ` +
      "Pass either an Expression<T> (e.g. val(...), typedCol(...)) or a primitive " +
      "scalar (string / number / boolean / null).",
  )
}

/** Factory matching the policy / sequence builder convention. */
export function createFunction(name: string, schema?: string): CreateFunctionBuilder {
  return new CreateFunctionBuilder(name, schema)
}

/**
 * Builder for {@link DropFunctionNode} — PostgreSQL
 * `DROP FUNCTION [IF EXISTS] <name>[(argTypes)] [CASCADE]`.
 *
 *  - `.argTypes(...)` — disambiguate overloads. PG refuses an
 *    ambiguous bare-name drop on an overloaded function.
 *  - `.ifExists()` — emit `IF EXISTS`.
 *  - `.cascade()` — emit `CASCADE`.
 */
export class DropFunctionBuilder {
  private readonly node: DropFunctionNode

  constructor(name: string, schema?: string)
  constructor(node: DropFunctionNode)
  constructor(arg1: string | DropFunctionNode, schema?: string) {
    if (typeof arg1 === "string") {
      this.node = { type: "drop_function", name: arg1, schema }
    } else {
      this.node = arg1
    }
  }

  private clone(patch: Partial<DropFunctionNode>): DropFunctionBuilder {
    return new DropFunctionBuilder({ ...this.node, ...patch })
  }

  argTypes(...types: string[]): DropFunctionBuilder {
    return this.clone({ argTypes: [...types] })
  }

  ifExists(): DropFunctionBuilder {
    return this.clone({ ifExists: true })
  }

  cascade(): DropFunctionBuilder {
    return this.clone({ cascade: true })
  }

  build(): DropFunctionNode {
    return {
      ...this.node,
      argTypes: this.node.argTypes ? [...this.node.argTypes] : undefined,
    }
  }
}

/** Factory for {@link DropFunctionBuilder}. */
export function dropFunction(name: string, schema?: string): DropFunctionBuilder {
  return new DropFunctionBuilder(name, schema)
}
