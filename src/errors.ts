export class SumakError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SumakError"
  }
}

export class InvalidExpressionError extends SumakError {
  constructor(message: string) {
    super(message)
    this.name = "InvalidExpressionError"
  }
}

export class UnsupportedDialectFeatureError extends SumakError {
  constructor(dialect: string, feature: string) {
    super(`${feature} is not supported in ${dialect}`)
    this.name = "UnsupportedDialectFeatureError"
  }
}

export class EmptyQueryError extends SumakError {
  constructor(queryType: string, missing?: string) {
    const detail = missing
      ? `missing required clause — ${missing} must be set first`
      : "missing required clauses"
    super(`Cannot build ${queryType}: ${detail}`)
    this.name = "EmptyQueryError"
  }
}

export class SecurityError extends SumakError {
  constructor(message: string) {
    super(message)
    this.name = "SecurityError"
  }
}

/**
 * Thrown when an AST traversal reaches a node type it doesn't handle.
 *
 * Paired with {@link assertNever} / `const _: never = node` patterns in
 * switch statements: if a new variant is added to an AST union without
 * updating every switch, the compiler errors at the `never` assignment.
 * This error is the runtime backstop for the rare case where a node
 * slips through (e.g. a plugin synthesizes a shape the type system
 * didn't cover).
 */
export class UnreachableNodeError extends SumakError {
  constructor(node: { type?: string } | unknown, context?: string) {
    const kind =
      node && typeof node === "object" && "type" in node
        ? String((node as { type: unknown }).type)
        : typeof node
    const prefix = context ? `${context}: ` : ""
    super(`${prefix}unhandled AST node kind "${kind}"`)
    this.name = "UnreachableNodeError"
  }
}

/**
 * Exhaustiveness helper. Use in the `default:` branch of a switch over a
 * discriminated union — TypeScript errors at compile time if a variant
 * was missed, and throws {@link UnreachableNodeError} at runtime as a
 * safety net for shapes that slip past the type system.
 */
export function assertNever(node: never, context?: string): never {
  throw new UnreachableNodeError(node as unknown, context)
}
