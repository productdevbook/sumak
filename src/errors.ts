export class PamukError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PamukError";
  }
}

export class InvalidExpressionError extends PamukError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidExpressionError";
  }
}

export class UnsupportedDialectFeatureError extends PamukError {
  constructor(dialect: string, feature: string) {
    super(`${feature} is not supported in ${dialect}`);
    this.name = "UnsupportedDialectFeatureError";
  }
}

export class EmptyQueryError extends PamukError {
  constructor(queryType: string) {
    super(`Cannot build ${queryType}: missing required clauses`);
    this.name = "EmptyQueryError";
  }
}
