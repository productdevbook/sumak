import type { ExpressionNode } from "../ast/nodes.ts";
import type { Expression } from "../ast/typed-expression.ts";
import type { SelectType } from "../schema/types.ts";
import {
  col as rawCol,
  lit as rawLit,
  param as rawParam,
  and as rawAnd,
  or as rawOr,
  fn as rawFn,
  star as rawStar,
} from "../ast/expression.ts";

/**
 * A typed column reference that exposes comparison methods.
 *
 * ```ts
 * // users.id.eq(42) → ("id" = $1) with param [42]
 * // users.name.like("%ali%") → ("name" LIKE '%ali%')
 * ```
 */
export class Col<T> {
  /** @internal */
  readonly _node: ExpressionNode;
  declare readonly _type: T;

  constructor(column: string, table?: string) {
    this._node = rawCol(column, table);
  }

  /** = */
  eq(value: T): Expression<boolean> {
    return wrap(binOp("=", this._node, autoParam(value)));
  }

  /** != */
  neq(value: T): Expression<boolean> {
    return wrap(binOp("!=", this._node, autoParam(value)));
  }

  /** > */
  gt(value: T): Expression<boolean> {
    return wrap(binOp(">", this._node, autoParam(value)));
  }

  /** >= */
  gte(value: T): Expression<boolean> {
    return wrap(binOp(">=", this._node, autoParam(value)));
  }

  /** < */
  lt(value: T): Expression<boolean> {
    return wrap(binOp("<", this._node, autoParam(value)));
  }

  /** <= */
  lte(value: T): Expression<boolean> {
    return wrap(binOp("<=", this._node, autoParam(value)));
  }

  /** LIKE (string columns only) */
  like(this: Col<string>, pattern: string): Expression<boolean> {
    return wrap(binOp("LIKE", this._node, rawLit(pattern)));
  }

  /** IN (value1, value2, ...) */
  in(values: T[]): Expression<boolean> {
    return wrap({
      type: "in",
      expr: this._node,
      values: values.map((v) => autoParam(v)),
      negated: false,
    });
  }

  /** NOT IN */
  notIn(values: T[]): Expression<boolean> {
    return wrap({
      type: "in",
      expr: this._node,
      values: values.map((v) => autoParam(v)),
      negated: true,
    });
  }

  /** IS NULL */
  isNull(): Expression<boolean> {
    return wrap({ type: "is_null", expr: this._node, negated: false });
  }

  /** IS NOT NULL */
  isNotNull(): Expression<boolean> {
    return wrap({ type: "is_null", expr: this._node, negated: true });
  }

  /** BETWEEN low AND high */
  between(low: T, high: T): Expression<boolean> {
    return wrap({
      type: "between",
      expr: this._node,
      low: autoParam(low),
      high: autoParam(high),
      negated: false,
    });
  }

  /** Compare with another column: col1.eqCol(col2) */
  eqCol(other: Col<T>): Expression<boolean> {
    return wrap(binOp("=", this._node, other._node));
  }

  /** As raw Expression<T> for advanced use */
  toExpr(): Expression<T> {
    return wrap<T>(this._node);
  }
}

// ── Internal helpers ──

let _paramIdx = 0;

export function resetParams(): void {
  _paramIdx = 0;
}

function autoParam(value: unknown): ExpressionNode {
  return rawParam(_paramIdx++, value);
}

function binOp(op: string, left: ExpressionNode, right: ExpressionNode): ExpressionNode {
  return { type: "binary_op", op, left, right };
}

function wrap<T>(node: ExpressionNode): Expression<T> {
  return { node } as Expression<T>;
}

/**
 * Create typed column proxies for a table's columns.
 *
 * Type: { id: Col<number>, name: Col<string>, ... }
 */
export type ColumnProxies<DB, TB extends keyof DB> = {
  [K in keyof DB[TB] & string]: Col<SelectType<DB[TB][K]>>;
};

/**
 * Create column proxy objects for use in where/on callbacks.
 */
export function createColumnProxies<DB, TB extends keyof DB>(
  _table: TB & string,
): ColumnProxies<DB, TB> {
  return new Proxy({} as ColumnProxies<DB, TB>, {
    get(_target, prop: string) {
      return new Col(prop, undefined);
    },
  });
}

/**
 * Expression builder callback type.
 *
 * ```ts
 * .where(({ id, name }) => id.eq(42))
 * ```
 */
export type WhereCallback<DB, TB extends keyof DB> = (
  cols: ColumnProxies<DB, TB>,
) => Expression<boolean>;

// ── Combinators for callback results ──

/** AND two expressions */
export function and(left: Expression<boolean>, right: Expression<boolean>): Expression<boolean> {
  return wrap(rawAnd((left as any).node, (right as any).node));
}

/** OR two expressions */
export function or(left: Expression<boolean>, right: Expression<boolean>): Expression<boolean> {
  return wrap(rawOr((left as any).node, (right as any).node));
}

/** Raw literal value as expression */
export function val<T extends string | number | boolean | null>(value: T): Expression<T> {
  return wrap<T>(rawLit(value));
}

/** SQL function call */
export function sqlFn(name: string, ...args: Expression<any>[]): Expression<any> {
  return wrap(
    rawFn(
      name,
      args.map((a) => (a as any).node),
    ),
  );
}

/** COUNT(*) */
export function count(): Expression<number> {
  return wrap(rawFn("COUNT", [rawStar()]));
}
