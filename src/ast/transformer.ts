import type {
  ASTNode,
  DeleteNode,
  ExpressionNode,
  InsertNode,
  MergeNode,
  SelectNode,
  UpdateNode,
} from "./nodes.ts"

export class ASTTransformer {
  transform(node: ASTNode): ASTNode {
    switch (node.type) {
      case "select":
        return this.transformSelect(node)
      case "insert":
        return this.transformInsert(node)
      case "update":
        return this.transformUpdate(node)
      case "delete":
        return this.transformDelete(node)
      case "merge":
        return this.transformMerge(node)
      case "explain":
        return { ...node, statement: this.transform(node.statement) as any }
      default:
        return this.transformExpression(node)
    }
  }

  transformSelect(node: SelectNode): SelectNode {
    return {
      ...node,
      columns: node.columns.map((c) => this.transformExpression(c)),
      where: node.where ? this.transformExpression(node.where) : undefined,
      having: node.having ? this.transformExpression(node.having) : undefined,
      joins: node.joins.map((j) => ({
        ...j,
        on: j.on ? this.transformExpression(j.on) : undefined,
      })),
      orderBy: node.orderBy.map((o) => ({
        ...o,
        expr: this.transformExpression(o.expr),
      })),
    }
  }

  transformInsert(node: InsertNode): InsertNode {
    return {
      ...node,
      values: node.values.map((row) => row.map((v) => this.transformExpression(v))),
    }
  }

  transformUpdate(node: UpdateNode): UpdateNode {
    return {
      ...node,
      set: node.set.map((s) => ({
        ...s,
        value: this.transformExpression(s.value),
      })),
      where: node.where ? this.transformExpression(node.where) : undefined,
    }
  }

  transformDelete(node: DeleteNode): DeleteNode {
    return {
      ...node,
      where: node.where ? this.transformExpression(node.where) : undefined,
    }
  }

  transformMerge(node: MergeNode): MergeNode {
    return {
      ...node,
      on: this.transformExpression(node.on),
      whens: node.whens.map((w) => {
        if (w.type === "matched") {
          return {
            ...w,
            condition: w.condition ? this.transformExpression(w.condition) : undefined,
            set: w.set?.map((s) => ({ ...s, value: this.transformExpression(s.value) })),
          }
        }
        return {
          ...w,
          condition: w.condition ? this.transformExpression(w.condition) : undefined,
          values: w.values.map((v) => this.transformExpression(v)),
        }
      }),
    }
  }

  transformExpression(node: ExpressionNode): ExpressionNode {
    switch (node.type) {
      case "binary_op":
        return {
          ...node,
          left: this.transformExpression(node.left),
          right: this.transformExpression(node.right),
        }
      case "unary_op":
        return {
          ...node,
          operand: this.transformExpression(node.operand),
        }
      case "function_call":
        return {
          ...node,
          args: node.args.map((a) => this.transformExpression(a)),
        }
      case "between":
        return {
          ...node,
          expr: this.transformExpression(node.expr),
          low: this.transformExpression(node.low),
          high: this.transformExpression(node.high),
        }
      case "in":
        return {
          ...node,
          expr: this.transformExpression(node.expr),
          values: Array.isArray(node.values)
            ? node.values.map((v) => this.transformExpression(v))
            : node.values,
        }
      case "is_null":
        return {
          ...node,
          expr: this.transformExpression(node.expr),
        }
      case "cast":
        return {
          ...node,
          expr: this.transformExpression(node.expr),
        }
      case "json_access":
        return {
          ...node,
          expr: this.transformExpression(node.expr),
        }
      case "array_expr":
        return {
          ...node,
          elements: node.elements.map((e) => this.transformExpression(e)),
        }
      case "window_function":
        return {
          ...node,
          fn: this.transformExpression(node.fn) as import("./nodes.ts").FunctionCallNode,
          partitionBy: node.partitionBy.map((p) => this.transformExpression(p)),
          orderBy: node.orderBy.map((o) => ({
            ...o,
            expr: this.transformExpression(o.expr),
          })),
        }
      case "aliased_expr":
        return {
          ...node,
          expr: this.transformExpression(node.expr),
        }
      case "full_text_search":
        return {
          ...node,
          columns: node.columns.map((c) => this.transformExpression(c)),
          query: this.transformExpression(node.query),
        }
      default:
        return node
    }
  }
}
