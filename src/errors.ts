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
