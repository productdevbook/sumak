import type { RawNode } from "../ast/nodes.ts";
import { raw as rawNode } from "../ast/expression.ts";

export function raw(sql: string, params: unknown[] = []): RawNode {
  return rawNode(sql, params);
}
