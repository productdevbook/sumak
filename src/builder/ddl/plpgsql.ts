import type {
  PlpgsqlBranch,
  PlpgsqlDeclaration,
  PlpgsqlRaiseLevel,
  PlpgsqlRaiseOption,
  PlpgsqlStatement,
  StatementBlockNode,
} from "../../ast/ddl-nodes.ts"
import type { ASTNode, ExpressionNode } from "../../ast/nodes.ts"
import type { Expression } from "../../ast/typed-expression.ts"
import { brandExpression, unwrap } from "../../ast/typed-expression.ts"

/** Anything that can stand where plpgsql wants an expression. */
export type Value<T> = Expression<T> | ExpressionNode

function node<T>(value: Value<T>): ExpressionNode {
  return typeof (value as Expression<T>).node === "object"
    ? unwrap(value as Expression<T>)
    : (value as ExpressionNode)
}

/** A query builder that can produce a statement — select, insert, update, delete. */
export interface Buildable {
  build(): ASTNode
}

function statementOf(query: Buildable | ASTNode): ASTNode {
  return typeof (query as Buildable).build === "function"
    ? (query as Buildable).build()
    : (query as ASTNode)
}

/**
 * The body of a plpgsql function, assembled statement by statement.
 *
 * Mutable on purpose. A block is written once, when the function is defined,
 * and sealed by the builder that owns it — copy-on-write would buy nothing and
 * make every method read worse.
 */
export class Block {
  private readonly declarations: PlpgsqlDeclaration[] = []
  private readonly statements: PlpgsqlStatement[] = []

  constructor(private readonly blockLabel?: string) {}

  /**
   * Declare a variable and get a reference to it.
   *
   * ```ts
   * const total = b.declare<number>("total", "numeric", { initial: val(0) })
   * b.assign(total, add(total, args.price))
   * ```
   */
  declare<T = unknown>(
    name: string,
    dataType: string,
    options: { initial?: Value<T>; constant?: boolean; notNull?: boolean } = {},
  ): Expression<T> {
    this.declarations.push({
      name,
      dataType,
      constant: options.constant,
      notNull: options.notNull,
      initial: options.initial === undefined ? undefined : node(options.initial),
    })
    return brandExpression<T>({ type: "column_ref", column: name })
  }

  /** `target := value` — the target is a declared variable or an argument. */
  assign<T>(target: Expression<T> | string, value: Value<T>): this {
    this.statements.push({ type: "plpgsql_assign", target: nameOf(target), value: node(value) })
    return this
  }

  /**
   * `IF … THEN … END IF`, with `.elseIf(...)` and `.else(...)` on the result.
   *
   * ```ts
   * b.if(gt(args.price, val(0)), (t) => t.return(args.price))
   *   .else((e) => e.raise("exception", "price must be positive"))
   * ```
   */
  if(condition: Value<boolean>, then: (block: Block) => void): IfChain {
    const branch: PlpgsqlBranch = { condition: node(condition), body: bodyOf(then) }
    const statement: PlpgsqlStatement = { type: "plpgsql_if", branches: [branch] }
    this.statements.push(statement)
    return new IfChain(statement)
  }

  while(condition: Value<boolean>, body: (block: Block) => void, label?: string): this {
    this.statements.push({
      type: "plpgsql_while",
      condition: node(condition),
      body: bodyOf(body),
      label,
    })
    return this
  }

  /** `FOR i IN a .. b [BY n] LOOP … END LOOP`. The loop variable is implicitly integer. */
  forRange(
    variable: string,
    from: Value<number>,
    to: Value<number>,
    body: (block: Block, index: Expression<number>) => void,
    options: { by?: Value<number>; reverse?: boolean; label?: string } = {},
  ): this {
    const index = brandExpression<number>({ type: "column_ref", column: variable })
    this.statements.push({
      type: "plpgsql_for_range",
      variable,
      from: node(from),
      to: node(to),
      by: options.by === undefined ? undefined : node(options.by),
      reverse: options.reverse,
      body: bodyOf((block) => body(block, index)),
      label: options.label,
    })
    return this
  }

  /** `FOR row IN <query> LOOP … END LOOP`. */
  forEach(
    variable: string,
    query: Buildable | ASTNode,
    body: (block: Block, row: Expression<unknown>) => void,
    label?: string,
  ): this {
    const row = brandExpression<unknown>({ type: "column_ref", column: variable })
    this.statements.push({
      type: "plpgsql_for_query",
      variable,
      query: statementOf(query),
      body: bodyOf((block) => body(block, row)),
      label,
    })
    return this
  }

  loop(body: (block: Block) => void, label?: string): this {
    this.statements.push({ type: "plpgsql_loop", body: bodyOf(body), label })
    return this
  }

  exit(options: { when?: Value<boolean>; label?: string } = {}): this {
    this.statements.push({
      type: "plpgsql_exit",
      label: options.label,
      when: options.when === undefined ? undefined : node(options.when),
    })
    return this
  }

  continue(options: { when?: Value<boolean>; label?: string } = {}): this {
    this.statements.push({
      type: "plpgsql_continue",
      label: options.label,
      when: options.when === undefined ? undefined : node(options.when),
    })
    return this
  }

  /**
   * `RAISE <level> '<message>' [USING …]`.
   *
   * The message is emitted as a literal, so it is the definition's own text and
   * never a caller's value. Anything dynamic goes through `using`.
   */
  raise(
    level: PlpgsqlRaiseLevel,
    message: string,
    using: { [K in PlpgsqlRaiseOption["option"]]?: Value<unknown> } = {},
  ): this {
    const options: PlpgsqlRaiseOption[] = []
    for (const [option, value] of Object.entries(using)) {
      if (value === undefined) continue
      options.push({ option: option as PlpgsqlRaiseOption["option"], value: node(value) })
    }
    this.statements.push({
      type: "plpgsql_raise",
      level,
      message,
      using: options.length > 0 ? options : undefined,
    })
    return this
  }

  /** Run a query for its effect and discard the result. */
  perform(query: Buildable | ASTNode): this {
    this.statements.push({ type: "plpgsql_perform", query: statementOf(query) })
    return this
  }

  /** Run a statement — an INSERT, UPDATE or DELETE — for its effect. */
  exec(query: Buildable | ASTNode): this {
    this.statements.push({ type: "plpgsql_statement", query: statementOf(query) })
    return this
  }

  /** A nested `DECLARE … BEGIN … END`, for a scope of its own. */
  block(body: (block: Block) => void, label?: string): this {
    const inner = new Block(label)
    body(inner)
    this.statements.push({ type: "plpgsql_block", block: inner.buildNode() })
    return this
  }

  return<T>(value?: Value<T>): this {
    this.statements.push({
      type: "plpgsql_return",
      value: value === undefined ? undefined : node(value),
    })
    return this
  }

  returnNext<T>(value: Value<T>): this {
    this.statements.push({ type: "plpgsql_return_next", value: node(value) })
    return this
  }

  returnQuery(query: Buildable | ASTNode): this {
    this.statements.push({ type: "plpgsql_return_query", query: statementOf(query) })
    return this
  }

  /** An explicit no-op, for a branch that deliberately does nothing. */
  nothing(): this {
    this.statements.push({ type: "plpgsql_null" })
    return this
  }

  buildNode(): StatementBlockNode {
    return {
      type: "statement_block",
      declarations: this.declarations.length > 0 ? this.declarations : undefined,
      statements: this.statements,
      label: this.blockLabel,
    }
  }
}

/** The `ELSIF` / `ELSE` tail of an `IF`. */
export class IfChain {
  constructor(private readonly statement: PlpgsqlStatement & { type: "plpgsql_if" }) {}

  elseIf(condition: Value<boolean>, then: (block: Block) => void): IfChain {
    this.statement.branches.push({ condition: node(condition), body: bodyOf(then) })
    return this
  }

  else(otherwise: (block: Block) => void): void {
    this.statement.otherwise = bodyOf(otherwise)
  }
}

function bodyOf(build: (block: Block) => void): PlpgsqlStatement[] {
  const block = new Block()
  build(block)
  const built = block.buildNode()
  // A nested body cannot declare: plpgsql only allows DECLARE at the head of a
  // block, so a declaration here becomes an inner BEGIN … END of its own.
  if (built.declarations !== undefined) {
    return [{ type: "plpgsql_block", block: built }]
  }
  return built.statements
}

function nameOf<T>(target: Expression<T> | string): string {
  if (typeof target === "string") return target
  const expr = unwrap(target)
  if (expr.type !== "column_ref") {
    throw new Error(
      "assign() needs a declared variable or an argument as its target, not an expression.",
    )
  }
  return expr.column
}

/**
 * The variables plpgsql puts in scope inside a trigger function.
 *
 * `NEW` and `OLD` are the row before and after; which of them exists depends on
 * the event, so both are typed nullable and the function is expected to branch
 * on `op`. `op` is `TG_OP`, and `table` / `schema` are `TG_TABLE_NAME` and
 * `TG_TABLE_SCHEMA`.
 */
export interface TriggerScope<Row> {
  new: { [K in keyof Row]: Expression<Row[K]> }
  old: { [K in keyof Row]: Expression<Row[K]> }
  op: Expression<"INSERT" | "UPDATE" | "DELETE" | "TRUNCATE">
  table: Expression<string>
  schema: Expression<string>
}

/**
 * Build the trigger scope for a row shape.
 *
 * The columns are the keys of `row`; the values are ignored, so a schema table
 * definition can be passed straight in.
 */
export function triggerScope<Row extends Record<string, unknown>>(
  row: Row | readonly (keyof Row & string)[],
): TriggerScope<Row> {
  const names = Array.isArray(row) ? row : (Object.keys(row) as (keyof Row & string)[])
  const qualified = (table: string) => {
    const out: Record<string, Expression<unknown>> = {}
    for (const name of names) {
      out[name] = brandExpression({ type: "column_ref", table, column: name })
    }
    return out as { [K in keyof Row]: Expression<Row[K]> }
  }
  // Lower case on purpose. plpgsql folds an unquoted identifier down, so its
  // variable is `new`; a quoted `"NEW"` is a different name and resolves to
  // nothing. The column half keeps whatever case the schema gave it.
  return {
    new: qualified("new"),
    old: qualified("old"),
    op: brandExpression({ type: "column_ref", column: "tg_op" }),
    table: brandExpression({ type: "column_ref", column: "tg_table_name" }),
    schema: brandExpression({ type: "column_ref", column: "tg_table_schema" }),
  }
}
