export class LaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaleError";
  }
}

export class InvalidExpressionError extends LaleError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidExpressionError";
  }
}

export class UnsupportedDialectFeatureError extends LaleError {
  constructor(dialect: string, feature: string) {
    super(`${feature} is not supported in ${dialect}`);
    this.name = "UnsupportedDialectFeatureError";
  }
}

export class EmptyQueryError extends LaleError {
  constructor(queryType: string) {
    super(`Cannot build ${queryType}: missing required clauses`);
    this.name = "EmptyQueryError";
  }
}
