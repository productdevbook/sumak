// AST
export type {
  AliasedExprNode,
  ArrayExprNode,
  ASTNode,
  BetweenNode,
  BinaryOpNode,
  CaseNode,
  CastNode,
  ColumnRefNode,
  CTENode,
  DeleteNode,
  ExistsNode,
  ExpressionNode,
  FrameBound,
  FrameKind,
  FrameSpec,
  FunctionCallNode,
  InNode,
  InsertNode,
  IsNullNode,
  JoinNode,
  JsonAccessNode,
  LiteralNode,
  OnConflictNode,
  OrderByNode,
  ParamNode,
  RawNode,
  SelectNode,
  StarNode,
  SubqueryNode,
  TableRefNode,
  UnaryOpNode,
  UpdateNode,
  WindowFunctionNode,
} from "./ast/nodes.ts"

export {
  createDeleteNode,
  createInsertNode,
  createSelectNode,
  createUpdateNode,
  tableRef,
} from "./ast/nodes.ts"

// Low-level AST expression factories (advanced use)
export {
  between,
  binOp,
  col,
  colAs,
  eq,
  fn,
  gt,
  gte,
  inList,
  isNull,
  like,
  lit,
  lt,
  lte,
  neq,
  param,
  raw,
  star,
  subquery,
  unaryOp,
} from "./ast/expression.ts"

export { ASTTransformer } from "./ast/transformer.ts"
export { visitNode } from "./ast/visitor.ts"
export type { ASTVisitor } from "./ast/visitor.ts"
export type { Expression } from "./ast/typed-expression.ts"

// Builders
export { select, SelectBuilder } from "./builder/select.ts"
export { insert, InsertBuilder } from "./builder/insert.ts"
export { update, UpdateBuilder } from "./builder/update.ts"
export { deleteFrom, DeleteBuilder } from "./builder/delete.ts"

// Printers
export { BasePrinter } from "./printer/base.ts"
export { PgPrinter } from "./printer/pg.ts"
export { MysqlPrinter } from "./printer/mysql.ts"
export { SqlitePrinter } from "./printer/sqlite.ts"
export { formatSQL } from "./printer/formatter.ts"
export type { FormatOptions } from "./printer/formatter.ts"
export type { Printer, PrinterOptions, PrintMode } from "./printer/types.ts"
export {
  concat as docConcat,
  empty as docEmpty,
  group as docGroup,
  join as docJoin,
  line as docLine,
  nest as docNest,
  render as docRender,
  text as docText,
  textLine as docTextLine,
} from "./printer/document.ts"
export type { Doc } from "./printer/document.ts"

// Dialects
export { pgDialect } from "./dialect/pg.ts"
export { mysqlDialect } from "./dialect/mysql.ts"
export { sqliteDialect } from "./dialect/sqlite.ts"
export type { Dialect } from "./dialect/types.ts"

// Utils
export { quoteIdentifier, quoteTableRef } from "./utils/identifier.ts"
export { formatParam } from "./utils/param.ts"

// Types
export type {
  CompiledQuery,
  DialectConfig,
  JoinType,
  OrderDirection,
  Primitive,
  SetOperator,
  SQLDialect,
} from "./types.ts"

// Schema
export {
  bigint,
  bigserial,
  boolean,
  bytea,
  char,
  ColumnBuilder,
  date,
  defineTable,
  doublePrecision,
  enumType,
  integer,
  json,
  jsonb,
  numeric,
  real,
  serial,
  smallint,
  text,
  time,
  timestamp,
  timestamptz,
  uuid,
  varchar,
} from "./schema/index.ts"
export type {
  ColumnDef,
  ColumnType,
  Generated,
  GeneratedAlways,
  InferTable,
  Insertable,
  InsertType,
  Nullable,
  Selectable,
  SelectRow,
  SelectType,
  TableDefinition,
  Updateable,
  UpdateType,
} from "./schema/index.ts"

// Expression builder (clean API)
export {
  and,
  avg,
  case_,
  CaseBuilder,
  cast,
  coalesce,
  Col,
  count,
  exists,
  jsonRef,
  max,
  min,
  not,
  notExists,
  or,
  resetParams,
  sqlFn,
  sum,
  val,
} from "./builder/eb.ts"
export type { ColumnProxies, WhereCallback } from "./builder/eb.ts"

// Typed builders
export { sumak, Sumak } from "./sumak.ts"
export type { SumakConfig } from "./sumak.ts"
export { TypedSelectBuilder } from "./builder/typed-select.ts"
export { TypedInsertBuilder, TypedInsertReturningBuilder } from "./builder/typed-insert.ts"
export { TypedUpdateBuilder, TypedUpdateReturningBuilder } from "./builder/typed-update.ts"
export { TypedDeleteBuilder, TypedDeleteReturningBuilder } from "./builder/typed-delete.ts"

// Plugins
export type { SumakPlugin } from "./plugin/types.ts"
export { PluginManager } from "./plugin/plugin-manager.ts"
export { WithSchemaPlugin } from "./plugin/with-schema.ts"
export { SoftDeletePlugin } from "./plugin/soft-delete.ts"
export { CamelCasePlugin } from "./plugin/camel-case.ts"

// Hooks
export { Hookable } from "./plugin/hooks.ts"
export type { HookContext, HookName, SumakHooks } from "./plugin/hooks.ts"

// Errors
export {
  EmptyQueryError,
  InvalidExpressionError,
  SumakError,
  UnsupportedDialectFeatureError,
} from "./errors.ts"
