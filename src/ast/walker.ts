import { assertNever } from "../errors.ts"
import type {
  ASTNode,
  CTENode,
  DeleteNode,
  ExpressionNode,
  ExplainNode,
  FunctionCallNode,
  InsertNode,
  JoinNode,
  MergeNode,
  OrderByNode,
  SelectNode,
  SubqueryNode,
  TableRefNode,
  UpdateNode,
} from "./nodes.ts"

/**
 * Base AST transformer — a single place where child traversal for every
 * node kind is defined.
 *
 * Every `visit*` method returns a (possibly) new node of the same kind.
 * Subclasses override the handful of methods they care about; the base
 * implementation descends into every child slot so a subclass that
 * overrides `visitSubquery` (say, to rewrite SELECTs inside `EXISTS`
 * and `IN (subquery)`) automatically reaches those positions through
 * MERGE `whens`, CTE `query`, UPDATE/DELETE joins, EXPLAIN `statement`,
 * window-function arguments, etc.
 *
 * **Identity preservation.** If every child of a node comes back as the
 * exact same reference (i.e. the subclass didn't replace anything in
 * that branch), the base methods return the original node object —
 * `Object.is(visited, node)` stays true. This is relied on by
 * normalizer no-op paths, tests that compare with `toBe`, and plugin
 * short-circuits that avoid reallocating unchanged subtrees.
 *
 * **Exhaustiveness.** `visitExpression` and `visitNode` both end in
 * `assertNever` — new variants added to `ExpressionNode` / `ASTNode`
 * fail at compile time here (and at runtime as a backstop), forcing
 * walker subclasses to be updated in lockstep.
 */
export class ASTWalker {
  // ── Top-level ASTNode dispatcher ─────────────────────────────────

  visitNode(node: ASTNode): ASTNode {
    switch (node.type) {
      case "select":
        return this.visitSelect(node)
      case "insert":
        return this.visitInsert(node)
      case "update":
        return this.visitUpdate(node)
      case "delete":
        return this.visitDelete(node)
      case "merge":
        return this.visitMerge(node)
      case "explain":
        return this.visitExplain(node)
      case "column_ref":
      case "literal":
      case "binary_op":
      case "unary_op":
      case "function_call":
      case "param":
      case "raw":
      case "subquery":
      case "between":
      case "in":
      case "is_null":
      case "case":
      case "cast":
      case "exists":
      case "star":
      case "json_access":
      case "array_expr":
      case "window_function":
      case "aliased_expr":
      case "full_text_search":
      case "tuple":
      case "quantified":
      case "grouping":
        return this.visitExpression(node)
      default:
        return assertNever(node, "ASTWalker.visitNode")
    }
  }

  // ── Statement nodes ──────────────────────────────────────────────

  visitSelect(node: SelectNode): SelectNode {
    const distinctOn = node.distinctOn
      ? mapPreserve(node.distinctOn, (e) => this.visitExpression(e))
      : node.distinctOn
    const columns = mapPreserve(node.columns, (c) => this.visitExpression(c))
    const from = node.from ? this.visitSelectFrom(node.from) : node.from
    const joins = mapPreserve(node.joins, (j) => this.visitJoin(j))
    const where = node.where ? this.visitExpression(node.where) : node.where
    const groupBy = mapPreserve(node.groupBy, (g) => this.visitExpression(g))
    const having = node.having ? this.visitExpression(node.having) : node.having
    const orderBy = mapPreserve(node.orderBy, (o) => this.visitOrderBy(o))
    const limit = node.limit ? this.visitExpression(node.limit) : node.limit
    const offset = node.offset ? this.visitExpression(node.offset) : node.offset
    const ctes = mapPreserve(node.ctes, (c) => this.visitCTE(c))
    const setOp = node.setOp ? this.visitSelectSetOp(node.setOp, node.setOp.query) : node.setOp

    if (
      distinctOn === node.distinctOn &&
      columns === node.columns &&
      from === node.from &&
      joins === node.joins &&
      where === node.where &&
      groupBy === node.groupBy &&
      having === node.having &&
      orderBy === node.orderBy &&
      limit === node.limit &&
      offset === node.offset &&
      ctes === node.ctes &&
      setOp === node.setOp
    ) {
      return node
    }
    return {
      ...node,
      distinctOn,
      columns,
      from,
      joins,
      where,
      groupBy,
      having,
      orderBy,
      limit,
      offset,
      ctes,
      setOp,
    }
  }

  protected visitSelectFrom(
    from: NonNullable<SelectNode["from"]>,
  ): NonNullable<SelectNode["from"]> {
    if (from.type === "subquery") return this.visitSubquery(from)
    if (from.type === "values_clause") {
      // Walk the per-row expressions so plugins / normalizers see
      // them. Keep identity-preserving: if no element changed we
      // return the original node.
      const rows = mapPreserve(from.rows, (row) => mapPreserve(row, (e) => this.visitExpression(e)))
      return rows === from.rows ? from : { ...from, rows }
    }
    // table_ref and graph_table have no child expressions / selects in
    // the common path — subclasses override if they need to descend.
    return from
  }

  protected visitSelectSetOp(
    setOp: NonNullable<SelectNode["setOp"]>,
    query: SelectNode,
  ): NonNullable<SelectNode["setOp"]> {
    const newQuery = this.visitSelect(query)
    return newQuery === query ? setOp : { ...setOp, query: newQuery }
  }

  visitInsert(node: InsertNode): InsertNode {
    const ctes = mapPreserve(node.ctes, (c) => this.visitCTE(c))
    const source = node.source ? this.visitSelect(node.source) : node.source
    const values = mapPreserve(node.values, (row) =>
      mapPreserve(row, (v) => this.visitExpression(v)),
    )
    const returning = mapPreserve(node.returning, (r) => this.visitExpression(r))
    const onConflict = node.onConflict
      ? this.visitInsertOnConflict(node.onConflict)
      : node.onConflict
    const onDuplicateKeyUpdate = node.onDuplicateKeyUpdate
      ? mapPreserve(node.onDuplicateKeyUpdate, (s) => {
          const value = this.visitExpression(s.value)
          return value === s.value ? s : { ...s, value }
        })
      : node.onDuplicateKeyUpdate

    if (
      ctes === node.ctes &&
      source === node.source &&
      values === node.values &&
      returning === node.returning &&
      onConflict === node.onConflict &&
      onDuplicateKeyUpdate === node.onDuplicateKeyUpdate
    ) {
      return node
    }
    return { ...node, ctes, source, values, returning, onConflict, onDuplicateKeyUpdate }
  }

  protected visitInsertOnConflict(
    onConflict: NonNullable<InsertNode["onConflict"]>,
  ): NonNullable<InsertNode["onConflict"]> {
    const action = onConflict.action
    let newAction = action
    if (typeof action !== "string") {
      const set = mapPreserve(action.set, (s) => {
        const value = this.visitExpression(s.value)
        return value === s.value ? s : { ...s, value }
      })
      newAction = set === action.set ? action : { set }
    }
    const where = onConflict.where ? this.visitExpression(onConflict.where) : onConflict.where
    if (newAction === action && where === onConflict.where) return onConflict
    return { ...onConflict, action: newAction, where }
  }

  visitUpdate(node: UpdateNode): UpdateNode {
    const ctes = mapPreserve(node.ctes, (c) => this.visitCTE(c))
    const set = mapPreserve(node.set, (s) => {
      const value = this.visitExpression(s.value)
      return value === s.value ? s : { ...s, value }
    })
    const joins = mapPreserve(node.joins, (j) => this.visitJoin(j))
    const where = node.where ? this.visitExpression(node.where) : node.where
    const returning = mapPreserve(node.returning, (r) => this.visitExpression(r))
    const orderBy = node.orderBy
      ? mapPreserve(node.orderBy, (o) => this.visitOrderBy(o))
      : node.orderBy
    const limit = node.limit ? this.visitExpression(node.limit) : node.limit

    if (
      ctes === node.ctes &&
      set === node.set &&
      joins === node.joins &&
      where === node.where &&
      returning === node.returning &&
      orderBy === node.orderBy &&
      limit === node.limit
    ) {
      return node
    }
    return { ...node, ctes, set, joins, where, returning, orderBy, limit }
  }

  visitDelete(node: DeleteNode): DeleteNode {
    const ctes = mapPreserve(node.ctes, (c) => this.visitCTE(c))
    const joins = mapPreserve(node.joins, (j) => this.visitJoin(j))
    const where = node.where ? this.visitExpression(node.where) : node.where
    const returning = mapPreserve(node.returning, (r) => this.visitExpression(r))
    const orderBy = node.orderBy
      ? mapPreserve(node.orderBy, (o) => this.visitOrderBy(o))
      : node.orderBy
    const limit = node.limit ? this.visitExpression(node.limit) : node.limit

    if (
      ctes === node.ctes &&
      joins === node.joins &&
      where === node.where &&
      returning === node.returning &&
      orderBy === node.orderBy &&
      limit === node.limit
    ) {
      return node
    }
    return { ...node, ctes, joins, where, returning, orderBy, limit }
  }

  visitMerge(node: MergeNode): MergeNode {
    const ctes = mapPreserve(node.ctes, (c) => this.visitCTE(c))
    const source = node.source.type === "subquery" ? this.visitSubquery(node.source) : node.source
    const on = this.visitExpression(node.on)
    const whens = mapPreserve(node.whens, (w) => {
      if (w.type === "matched") {
        const condition = w.condition ? this.visitExpression(w.condition) : w.condition
        const set = w.set
          ? mapPreserve(w.set, (s) => {
              const value = this.visitExpression(s.value)
              return value === s.value ? s : { ...s, value }
            })
          : w.set
        if (condition === w.condition && set === w.set) return w
        return { ...w, condition, set }
      }
      const condition = w.condition ? this.visitExpression(w.condition) : w.condition
      const values = mapPreserve(w.values, (v) => this.visitExpression(v))
      if (condition === w.condition && values === w.values) return w
      return { ...w, condition, values }
    })

    if (ctes === node.ctes && source === node.source && on === node.on && whens === node.whens) {
      return node
    }
    return { ...node, ctes, source, on, whens }
  }

  visitExplain(node: ExplainNode): ExplainNode {
    const statement = this.visitNode(node.statement) as typeof node.statement
    return statement === node.statement ? node : { ...node, statement }
  }

  // ── Auxiliary nodes ──────────────────────────────────────────────

  visitCTE(cte: CTENode): CTENode {
    const query = this.visitSelect(cte.query)
    return query === cte.query ? cte : { ...cte, query }
  }

  visitJoin(join: JoinNode): JoinNode {
    const table = join.table.type === "subquery" ? this.visitSubquery(join.table) : join.table
    const on = join.on ? this.visitExpression(join.on) : join.on
    if (table === join.table && on === join.on) return join
    return { ...join, table, on }
  }

  visitOrderBy(order: OrderByNode): OrderByNode {
    const expr = this.visitExpression(order.expr)
    return expr === order.expr ? order : { ...order, expr }
  }

  visitSubquery(sub: SubqueryNode): SubqueryNode {
    const query = this.visitSelect(sub.query)
    return query === sub.query ? sub : { ...sub, query }
  }

  /** Override hook — default: unchanged. Subclasses may rename, schema-prefix, etc. */
  visitTableRef(table: TableRefNode): TableRefNode {
    return table
  }

  // ── Expression dispatcher ────────────────────────────────────────

  visitExpression(expr: ExpressionNode): ExpressionNode {
    switch (expr.type) {
      case "column_ref":
      case "literal":
      case "param":
      case "raw":
      case "star":
        return expr
      case "binary_op": {
        const left = this.visitExpression(expr.left)
        const right = this.visitExpression(expr.right)
        if (left === expr.left && right === expr.right) return expr
        return { ...expr, left, right }
      }
      case "unary_op": {
        const operand = this.visitExpression(expr.operand)
        return operand === expr.operand ? expr : { ...expr, operand }
      }
      case "function_call": {
        const args = mapPreserve(expr.args, (a) => this.visitExpression(a))
        const filter = expr.filter ? this.visitExpression(expr.filter) : expr.filter
        if (args === expr.args && filter === expr.filter) return expr
        return { ...expr, args, filter }
      }
      case "subquery":
        return this.visitSubquery(expr)
      case "between": {
        const e = this.visitExpression(expr.expr)
        const low = this.visitExpression(expr.low)
        const high = this.visitExpression(expr.high)
        if (e === expr.expr && low === expr.low && high === expr.high) return expr
        return { ...expr, expr: e, low, high }
      }
      case "in": {
        const e = this.visitExpression(expr.expr)
        const values = Array.isArray(expr.values)
          ? mapPreserve(expr.values, (v) => this.visitExpression(v))
          : this.visitSelect(expr.values)
        if (e === expr.expr && values === expr.values) return expr
        return { ...expr, expr: e, values }
      }
      case "is_null": {
        const e = this.visitExpression(expr.expr)
        return e === expr.expr ? expr : { ...expr, expr: e }
      }
      case "case": {
        const operand = expr.operand ? this.visitExpression(expr.operand) : expr.operand
        const whens = mapPreserve(expr.whens, (w) => {
          const condition = this.visitExpression(w.condition)
          const result = this.visitExpression(w.result)
          if (condition === w.condition && result === w.result) return w
          return { condition, result }
        })
        const else_ = expr.else_ ? this.visitExpression(expr.else_) : expr.else_
        if (operand === expr.operand && whens === expr.whens && else_ === expr.else_) return expr
        return { ...expr, operand, whens, else_ }
      }
      case "cast": {
        const e = this.visitExpression(expr.expr)
        return e === expr.expr ? expr : { ...expr, expr: e }
      }
      case "exists": {
        const query = this.visitSelect(expr.query)
        return query === expr.query ? expr : { ...expr, query }
      }
      case "json_access": {
        const e = this.visitExpression(expr.expr)
        return e === expr.expr ? expr : { ...expr, expr: e }
      }
      case "array_expr": {
        const elements = mapPreserve(expr.elements, (e) => this.visitExpression(e))
        return elements === expr.elements ? expr : { ...expr, elements }
      }
      case "window_function": {
        const fn = this.visitExpression(expr.fn) as FunctionCallNode
        const partitionBy = mapPreserve(expr.partitionBy, (p) => this.visitExpression(p))
        const orderBy = mapPreserve(expr.orderBy, (o) => this.visitOrderBy(o))
        if (fn === expr.fn && partitionBy === expr.partitionBy && orderBy === expr.orderBy)
          return expr
        return { ...expr, fn, partitionBy, orderBy }
      }
      case "aliased_expr": {
        const e = this.visitExpression(expr.expr)
        return e === expr.expr ? expr : { ...expr, expr: e }
      }
      case "full_text_search": {
        const columns = mapPreserve(expr.columns, (c) => this.visitExpression(c))
        const query = this.visitExpression(expr.query)
        if (columns === expr.columns && query === expr.query) return expr
        return { ...expr, columns, query }
      }
      case "tuple": {
        const elements = mapPreserve(expr.elements, (e) => this.visitExpression(e))
        return elements === expr.elements ? expr : { ...expr, elements }
      }
      case "quantified": {
        // Operand is one of: subquery, array_expr, param, raw. Walk
        // through `visitExpression` so inner column refs / params /
        // subqueries pass through the same transforms the rest of the
        // tree sees.
        const operand = this.visitExpression(expr.operand) as typeof expr.operand
        return operand === expr.operand ? expr : { ...expr, operand }
      }
      case "grouping": {
        const sets = mapPreserve(expr.sets, (set) =>
          mapPreserve(set, (e) => this.visitExpression(e)),
        )
        return sets === expr.sets ? expr : { ...expr, sets }
      }
      default:
        return assertNever(expr, "ASTWalker.visitExpression")
    }
  }
}

/**
 * `Array.prototype.map` variant that returns the original array when every
 * element comes back unchanged. Keeps identity stable down the walker so
 * parents can short-circuit on no-op children.
 */
export function mapPreserve<T>(arr: T[], fn: (t: T) => T): T[] {
  let changed = false
  const out: T[] = Array.from({ length: arr.length })
  for (let i = 0; i < arr.length; i++) {
    const next = fn(arr[i])
    if (next !== arr[i]) changed = true
    out[i] = next
  }
  return changed ? out : arr
}
