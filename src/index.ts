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
  ExplainNode,
  ExpressionNode,
  FrameBound,
  FrameKind,
  FrameSpec,
  FullTextSearchMode,
  FullTextSearchNode,
  FunctionCallNode,
  InNode,
  InsertMode,
  InsertNode,
  IsNullNode,
  JoinNode,
  JsonAccessNode,
  LiteralNode,
  LockClause,
  LockMode,
  MergeNode,
  MergeWhenMatched,
  MergeWhenNotMatched,
  OnConflictNode,
  OrderByNode,
  ParamNode,
  RawNode,
  SelectNode,
  StarNode,
  SubqueryNode,
  TableRefNode,
  TupleNode,
  TemporalClause,
  UnaryOpNode,
  UpdateNode,
  WindowFunctionNode,
} from "./ast/nodes.ts"

export {
  createDeleteNode,
  createInsertNode,
  createMergeNode,
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
export { merge, MergeBuilder } from "./builder/merge.ts"
export { select, SelectBuilder } from "./builder/select.ts"
export { insert, InsertBuilder } from "./builder/insert.ts"
export { update, UpdateBuilder } from "./builder/update.ts"
export { deleteFrom, DeleteBuilder } from "./builder/delete.ts"

// Printers
export { BasePrinter } from "./printer/base.ts"
export { PgPrinter } from "./printer/pg.ts"
export { MssqlPrinter } from "./printer/mssql.ts"
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
export { mssqlDialect } from "./dialect/mssql.ts"
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
  interval,
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
  abs,
  add,
  aggOrderBy,
  and,
  arrayAgg,
  arrayContainedBy,
  arrayContains,
  arrayOverlaps,
  avg,
  avgDistinct,
  case_,
  CaseBuilder,
  cast,
  ceil,
  coalesce,
  Col,
  concat,
  count,
  countDistinct,
  currentTimestamp,
  denseRank,
  div,
  exists,
  filter,
  floor,
  greatest,
  jsonAgg,
  jsonBuildObject,
  jsonRef,
  lag,
  lead,
  least,
  length,
  lower,
  max,
  min,
  mod,
  mul,
  neg,
  not,
  notExists,
  now,
  ntile,
  nullif,
  or,
  over,
  rank,
  rawExpr,
  round,
  rowNumber,
  sqlFn,
  stringAgg,
  subqueryExpr,
  sub,
  substring,
  sum,
  sumDistinct,
  textSearch,
  toJson,
  trim,
  tuple,
  upper,
  val,
  WindowBuilder,
} from "./builder/eb.ts"
export type { ColumnProxies, WhereCallback } from "./builder/eb.ts"

// SQL tagged template
export { sql } from "./builder/sql.ts"

// Typed builders
export { sumak, Sumak } from "./sumak.ts"
export type { SumakConfig } from "./sumak.ts"
export { TypedSelectBuilder } from "./builder/typed-select.ts"
export { TypedInsertBuilder, TypedInsertReturningBuilder } from "./builder/typed-insert.ts"
export { TypedUpdateBuilder, TypedUpdateReturningBuilder } from "./builder/typed-update.ts"
export { TypedDeleteBuilder, TypedDeleteReturningBuilder } from "./builder/typed-delete.ts"
export { TypedMergeBuilder } from "./builder/typed-merge.ts"

// Plugins
export type { SumakPlugin } from "./plugin/types.ts"
export { PluginManager } from "./plugin/plugin-manager.ts"
export { WithSchemaPlugin } from "./plugin/with-schema.ts"
export { SoftDeletePlugin } from "./plugin/soft-delete.ts"
export { CamelCasePlugin } from "./plugin/camel-case.ts"
export { AuditTimestampPlugin } from "./plugin/audit-timestamp.ts"
export { OptimisticLockPlugin } from "./plugin/optimistic-lock.ts"
export { DataMaskingPlugin } from "./plugin/data-masking.ts"
export { MultiTenantPlugin } from "./plugin/multi-tenant.ts"
export { QueryLimitPlugin } from "./plugin/query-limit.ts"

// Hooks
export { Hookable } from "./plugin/hooks.ts"
export type { HookContext, HookName, SumakHooks } from "./plugin/hooks.ts"

// DDL builders
export {
  CreateTableBuilder,
  ColumnDefBuilder,
  ForeignKeyBuilder,
} from "./builder/ddl/create-table.ts"
export { AlterTableBuilder } from "./builder/ddl/alter-table.ts"
export { CreateIndexBuilder } from "./builder/ddl/create-index.ts"
export { CreateViewBuilder } from "./builder/ddl/create-view.ts"
export {
  DropTableBuilder,
  DropIndexBuilder,
  DropViewBuilder,
  TruncateTableBuilder,
} from "./builder/ddl/drop.ts"
export { DDLPrinter } from "./printer/ddl.ts"
export { SchemaBuilder } from "./sumak.ts"

// DDL AST types
export type {
  AlterColumnSet,
  AlterTableAction,
  AlterTableNode,
  CheckConstraintNode,
  ColumnDefinitionNode,
  CreateIndexNode,
  CreateTableNode,
  CreateViewNode,
  DDLNode,
  DropIndexNode,
  DropTableNode,
  DropViewNode,
  ForeignKeyAction,
  ForeignKeyConstraintNode,
  PrimaryKeyConstraintNode,
  TableConstraintNode,
  TruncateTableNode,
  UniqueConstraintNode,
} from "./ast/ddl-nodes.ts"

// Errors
export {
  EmptyQueryError,
  InvalidExpressionError,
  SumakError,
  UnsupportedDialectFeatureError,
} from "./errors.ts"
