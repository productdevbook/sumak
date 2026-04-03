import type { ExpressionNode } from "../ast/nodes.ts";
import {
  and,
  between,
  binOp,
  col,
  eq,
  exists,
  gt,
  gte,
  inList,
  isNull,
  like,
  lit,
  lt,
  lte,
  neq,
  not,
  or,
  param,
} from "../ast/expression.ts";

let paramCounter = 0;

export function resetParamCounter(): void {
  paramCounter = 0;
}

export function val(value: unknown): ExpressionNode {
  const index = paramCounter++;
  return param(index, value);
}

export {
  and,
  between,
  binOp,
  col,
  eq,
  exists,
  gt,
  gte,
  inList,
  isNull,
  like,
  lit,
  lt,
  lte,
  neq,
  not,
  or,
};
