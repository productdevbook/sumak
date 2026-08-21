// ═══════════════════════════════════════════════════════════════════════════
//  sumak — v0.1 public API
//
//  Target: ~50 named exports (was ~206). Internals are no longer re-exported.
//  Advanced helpers — low-level AST factories, visitors, document algebra,
//  printer classes, DDL builder classes, normalize/optimize rule internals —
//  live under the `ast` namespace or are simply kept internal.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Core ──────────────────────────────────────────────────────────────────
export { sumak, Sumak, ScopedSumak, SchemaBuilder } from "./sumak.ts"
export type { SumakConfig } from "./sumak.ts"

// ─── Dialects ──────────────────────────────────────────────────────────────
export { pgDialect } from "./dialect/pg.ts"
export { mssqlDialect } from "./dialect/mssql.ts"
export { mysqlDialect } from "./dialect/mysql.ts"
export { sqliteDialect } from "./dialect/sqlite.ts"
export type { Dialect } from "./dialect/types.ts"
export { assertFeature, dialectsForFeature, FEATURES, supportsFeature } from "./dialect/features.ts"
export type { FeatureKey } from "./dialect/features.ts"

// ─── Query builders (renamed: Typed* → *, untyped classes are now internal) ─
export { TypedSelectBuilder as SelectBuilder } from "./builder/typed-select.ts"
export { TypedInsertBuilder as InsertBuilder } from "./builder/typed-insert.ts"
export { TypedUpdateBuilder as UpdateBuilder } from "./builder/typed-update.ts"
export { TypedDeleteBuilder as DeleteBuilder } from "./builder/typed-delete.ts"
export { TypedMergeBuilder as MergeBuilder } from "./builder/typed-merge.ts"
export { SoftDeleteBuilder, RestoreBuilder } from "./builder/soft-delete.ts"
export { ExplainBuilder } from "./builder/explain.ts"

// SQL:2023 Part 16 (SQL/PGQ) Property Graph Queries — @experimental spike.
export { GraphTableBuilder, graphTable } from "./builder/graph-table.ts"
export type { GraphColumnNode, GraphPatternNode, GraphTableNode } from "./ast/graph-nodes.ts"

// ─── Namespaces (v0.1 API) ─────────────────────────────────────────────────
// ast — low-level AST factories & traversal (advanced / plugin authors)
// win — window functions (rowNumber, rank, lag, lead, over, …)
// str — string functions (upper, lower, concat, …)
// num — math functions (abs, round, greatest, …)
// arr — PostgreSQL array operators (contains, containedBy, overlaps)
// tx  — transaction control (begin/commit/rollback/savepoint/…)
export { arr, ast, num, op, str, tx, win } from "./ns/index.ts"
export type { BeginOptions, CommitOptions, SetTransactionOptions } from "./ns/index.ts"

// ─── Expressions (core set, flat for ergonomics) ───────────────────────────
export {
  and,
  case_,
  cast,
  coalesce,
  Col,
  exists,
  filter,
  isJson,
  mergeAction,
  mergeActionMssql,
  not,
  notExists,
  nullif,
  or,
  over,
  sqlFn,
  val,
} from "./builder/eb.ts"
export { sql } from "./builder/sql.ts"
export type { CaseBuilder, ColumnProxies, WhereCallback } from "./builder/eb.ts"

// ─── Aggregates ────────────────────────────────────────────────────────────
export {
  anyValue,
  arrayAgg,
  avg,
  avgDistinct,
  bitAnd,
  bitOr,
  bitXor,
  boolAnd,
  boolOr,
  corr,
  count,
  countDistinct,
  covarPop,
  covarSamp,
  firstValue,
  lastValue,
  max,
  min,
  nthValue,
  percentileCont,
  percentileDisc,
  regrIntercept,
  regrR2,
  regrSlope,
  stddev,
  stddevPop,
  stddevSamp,
  stringAgg,
  sum,
  sumDistinct,
  variance,
  variancePop,
  varianceSamp,
  jsonAgg,
  aggOrderBy,
  withinGroup,
} from "./builder/eb.ts"

// ─── Scalar helpers & subqueries ───────────────────────────────────────────
export { subqueryExpr, toJson, tuple } from "./builder/eb.ts"

// ─── Escape hatches — use only when no typed helper fits ───────────────────
export { unsafeRawExpr, unsafeSqlFn } from "./builder/eb.ts"
// Opt-in audit around the escape hatches + static AST auditors.
export { findRawNodes, hasRawNodes, setUnsafeWarnHandler } from "./security.ts"
export type { RawOccurrence, UnsafeUsageEvent, UnsafeUsageHandler } from "./security.ts"
export {
  all,
  any,
  arrayLiteral,
  cube,
  groupingSets,
  rollup,
  some,
  valuesClause,
} from "./builder/eb.ts"

// ─── PostgreSQL array function builders (PG-only) ──────────────────────────
// `arrayAppend` / `arrayPrepend` / `arrayCat` / `arrayLength` /
// `arrayPositions` / `arrayPosition` / `arrayRemove` / `arrayReplace` /
// `arrayToString` / `unnest` — function-call helpers around PG's first-class
// array type, gated by the single `PG_ARRAY_FNS` feature flag. Each non-PG
// printer override throws `UnsupportedDialectFeatureError` at compile time.
export {
  arrayAppend,
  arrayPrepend,
  arrayCat,
  arrayLength,
  arrayPositions,
  arrayPosition,
  arrayRemove,
  arrayReplace,
  arrayToString,
  unnest,
} from "./builder/eb.ts"

// ─── ON CONFLICT helpers ───────────────────────────────────────────────────
// `excluded("name")` → `EXCLUDED."name"` — PG's pseudo-table reference
// for the row that would have been inserted (use inside `.onConflict()`).
export { excluded } from "./builder/eb.ts"

// ─── Date/time helpers ─────────────────────────────────────────────────────
export { now, currentTimestamp, extract, dateTrunc, age, dateAdd, dateSub } from "./builder/eb.ts"
export type { DateIntervalUnit } from "./builder/eb.ts"

// ─── Regex helpers ─────────────────────────────────────────────────────────
// Typed regex string functions. Dialect support varies — `regexpMatches`
// is PG-only, `regexpLike` is PG/MySQL, `regexpReplace` is PG/MySQL/
// SQLite (with the regexp extension), `regexpSubstr` is PG/MySQL.
export { regexpReplace, regexpLike, regexpMatches, regexpSubstr } from "./builder/eb.ts"

// ─── Sequence access (PG-only — refused on other dialects at print) ────────
export { nextval, currval, setval } from "./builder/eb.ts"

// ─── String manipulation helpers ───────────────────────────────────────────
// Typed string functions sitting alongside the flat `upper` / `lower` /
// `concat` / `substring` / `trim` / `length` (which are surfaced via the
// `str` namespace). `overlay` is PG/MySQL 8/MSSQL only (SQLite refuses);
// `position` is PG/MySQL/SQLite natively + MSSQL via printer translation
// to `CHARINDEX`. The remaining four (`replace`, `ltrim`, `rtrim`,
// `reverse`) are portable across all four dialects.
export { replace, position, overlay, ltrim, rtrim, reverse } from "./builder/eb.ts"

// ─── Full-text search & JSON helpers (stable subset) ───────────────────────
export {
  textSearch,
  jsonRef,
  jsonBuildObject,
  jsonValue,
  jsonQuery,
  jsonExists,
} from "./builder/eb.ts"

// ─── JSON optics (composable, typed JSON navigation) ───────────────────────
export { JsonOptic, JsonExpr, jsonCol, jsonExpr } from "./builder/json-optics.ts"

// ─── Compiled queries (pre-baked SQL with placeholders) ────────────────────
export { compileQuery, placeholder } from "./builder/compiled.ts"
export type { CompiledQueryFn, PlaceholderMarker } from "./builder/compiled.ts"

// ─── Pipeline knobs (NbE + rewrite rules) ──────────────────────────────────
export { createRule } from "./optimize/index.ts"
export type { RewriteRule, OptimizeOptions } from "./optimize/index.ts"
export type { NormalizeOptions } from "./normalize/index.ts"

// ─── Schema — column factories & table helpers ─────────────────────────────
export {
  bigint,
  bigserial,
  boolean,
  bytea,
  char,
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
  InferInsertModel,
  InferSelectModel,
  InferTable,
  InferUpdateModel,
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

// ─── Plugins (factory functions — preferred API) ───────────────────────────
export {
  audit,
  camelCase,
  caslAuthz,
  dataMasking,
  debugLogger,
  defaults,
  multiTenant,
  normalizeStrings,
  optimisticLock,
  queryLimit,
  softDelete,
  subjectType,
  validators,
  withSchema,
} from "./plugin/factories.ts"
export type { CaslAuthzConfig, SubjectTypeConfig } from "./plugin/factories.ts"
export type { DebugLogEntry, DebugLoggerConfig, DebugLogPhase } from "./plugin/debug-logger.ts"
export type { DefaultsConfig, DefaultThunk, TableDefaults } from "./plugin/defaults.ts"
export type {
  NormalizeStringsConfig,
  NormalizeTransform,
  NormalizeTransformSpec,
} from "./plugin/normalize-strings.ts"
export type { ResultContext, SumakPlugin, SumakPluginSetupContext } from "./plugin/types.ts"
export type { Validator, ValidatorsConfig } from "./plugin/validators.ts"

// ─── CASL integration — opt-in utility path (no plugin required) ───────────
// Re-exports so `import { caslToSumakWhere, ForbiddenByCaslError,
// UnsupportedCaslOperatorError } from "sumak"` works alongside the
// plugin. Converter and types are also here for advanced callers who
// want to build their own authz plugin on top of the ucast→AST core.
// No CASL import — the utility walks `ability.rulesFor(...)` + reads
// `rule.ast` / `rule.inverted` itself, so sumak stays CASL-dep-free.
export {
  caslToSumakWhere,
  ForbiddenByCaslError,
  UnsupportedCaslOperatorError,
} from "./casl/where.ts"
export type { AbilityLike } from "./casl/where.ts"
export { ucastToExpressionNode } from "./casl/ucast-to-ast.ts"
export type { UcastCondition } from "./casl/ucast-to-ast.ts"

// ─── Hooks ─────────────────────────────────────────────────────────────────
export type { HookContext, HookName, SumakHooks } from "./plugin/hooks.ts"

// ─── Core types ────────────────────────────────────────────────────────────
export type {
  CompiledQuery,
  DialectConfig,
  JoinType,
  OrderDirection,
  Primitive,
  SetOperator,
  SQLDialect,
} from "./types.ts"
export type { Expression } from "./ast/typed-expression.ts"
export type { Printer } from "./printer/types.ts"

// ─── AST node types (for type-level work & custom plugins) ─────────────────
export type {
  ASTNode,
  SelectNode,
  InsertNode,
  UpdateNode,
  DeleteNode,
  MergeNode,
  ExplainNode,
  ExpressionNode,
} from "./ast/nodes.ts"

// ─── DDL AST types (for typing `db.compileDDL` / custom DDL flows) ─────────
export type {
  AlterPolicyNode,
  AlterSequenceNode,
  AlterTypeAddValueNode,
  AlterTypeRenameNode,
  AlterTypeRenameValueNode,
  AnalyzeNode,
  CommentNode,
  CopyNode,
  CopyOptions,
  CreateDomainNode,
  CreateExtensionNode,
  CreateFunctionNode,
  CreatePolicyNode,
  CreateSchemaNode,
  CreateSequenceNode,
  CreateTriggerNode,
  CreateTypeEnumNode,
  CreateViewNode,
  DDLNode,
  DropDomainNode,
  DropExtensionNode,
  DropFunctionNode,
  DropPolicyNode,
  DropSchemaNode,
  DropSequenceNode,
  DropTriggerNode,
  DropTypeNode,
  DropViewNode,
  FunctionArg,
  ListenNode,
  LockTableNode,
  NotifyNode,
  RefreshMaterializedViewNode,
  ReindexNode,
  TruncateTableNode,
  UnlistenNode,
  VacuumNode,
} from "./ast/ddl-nodes.ts"

// ─── DDL builders (advanced / custom DDL flows) ────────────────────────────
export { CreateViewBuilder, RefreshMaterializedViewBuilder } from "./builder/ddl/create-view.ts"
export { DropViewBuilder, TruncateTableBuilder } from "./builder/ddl/drop.ts"
export {
  CreateSequenceBuilder,
  createSequence,
  DropSequenceBuilder,
  dropSequence,
} from "./builder/ddl/create-sequence.ts"
export { AlterSequenceBuilder, alterSequence } from "./builder/ddl/alter-sequence.ts"
export { TruncateBuilder, truncate, type TruncateTableArg } from "./builder/ddl/truncate.ts"
export {
  AnalyzeBuilder,
  analyze,
  ReindexBuilder,
  reindex,
  VacuumBuilder,
  vacuum,
} from "./builder/ddl/maintenance.ts"
export {
  AlterPolicyBuilder,
  alterPolicy,
  CreatePolicyBuilder,
  createPolicy,
  DropPolicyBuilder,
  dropPolicy,
} from "./builder/ddl/policy.ts"
export { CreateExtensionBuilder, DropExtensionBuilder } from "./builder/ddl/extension.ts"
export {
  AlterTypeAddValueBuilder,
  alterTypeAddValue,
  AlterTypeRenameBuilder,
  alterTypeRename,
  AlterTypeRenameValueBuilder,
  alterTypeRenameValue,
  CreateDomainBuilder,
  createDomain,
  CreateTypeEnumBuilder,
  createTypeEnum,
  DropDomainBuilder,
  dropDomain,
  DropTypeBuilder,
  dropType,
} from "./builder/ddl/custom-types.ts"
export { LockTableBuilder, type LockMode, lockTable } from "./builder/ddl/lock-table.ts"
export { CopyFromBuilder, CopyToBuilder, copyFrom, copyTo } from "./builder/ddl/copy.ts"
export {
  ListenBuilder,
  listen,
  NotifyBuilder,
  notify,
  UnlistenBuilder,
  unlisten,
} from "./builder/ddl/pubsub.ts"
export {
  arg,
  CreateFunctionBuilder,
  createFunction,
  DropFunctionBuilder,
  dropFunction,
} from "./builder/ddl/function.ts"
export type { FunctionArgSpec, SqlToTs, TypedFunction } from "./builder/ddl/function.ts"
export { Block, IfChain, triggerScope } from "./builder/ddl/plpgsql.ts"
export type { Buildable, TriggerScope, Value } from "./builder/ddl/plpgsql.ts"
export {
  CreateTriggerBuilder,
  createTrigger,
  DropTriggerBuilder,
  dropTrigger,
} from "./builder/ddl/trigger.ts"

// QueryFlags — builder-intent bitmap surfaced on SELECT/UPDATE/DELETE nodes.
export { QueryFlags } from "./ast/nodes.ts"

// ─── TCL AST types (transactions) ──────────────────────────────────────────
export type {
  AccessMode,
  BeginNode,
  CommitNode,
  IsolationLevel,
  ReleaseSavepointNode,
  RollbackNode,
  SavepointNode,
  SetTransactionNode,
  SQLiteLockingMode,
  TclNode,
} from "./ast/tcl-nodes.ts"

// ─── Errors ────────────────────────────────────────────────────────────────
export {
  assertNever,
  CrossTenantJoinError,
  EmptyQueryError,
  InvalidExpressionError,
  SecurityError,
  SumakError,
  UnreachableNodeError,
  UnsupportedDialectFeatureError,
  ValidationError,
} from "./errors.ts"

// ─── Driver adapter ────────────────────────────────────────────────────────
// Optional execute layer — pass a `Driver` to `sumak({ …, driver })` and
// then call `.many()` / `.one()` / `.first()` / `.exec()` on builders.
export type {
  Driver,
  DriverCallOptions,
  ExecuteResult,
  OnQueryListener,
  QueryEndEvent,
  QueryErrorEvent,
  QueryEvent,
  QueryEventKind,
  QueryStartEvent,
  Row,
} from "./driver/types.ts"
export { AbortError, isAbortError, withSignal } from "./driver/types.ts"
export { MissingDriverError, UnexpectedRowCountError } from "./driver/execute.ts"
export type { TransactionOptions } from "./driver/transaction.ts"

// ─── Introspection ─────────────────────────────────────────────────────────
// Read a live database's schema through a Driver, normalise to
// IntrospectedSchema, and optionally generate matching sumak TS code.
export {
  generateSchemaCode,
  introspect,
  introspectMssql,
  introspectMysql,
  introspectPg,
  introspectSqlite,
} from "./introspect/index.ts"
export type {
  GenerateOptions,
  IntrospectedColumn,
  IntrospectedSchema,
  IntrospectedTable,
} from "./introspect/index.ts"

// ─── Migrations ────────────────────────────────────────────────────────────
// Structural schema-diff → DDL. Feed your current `tables` shape plus
// the desired shape; get back a list of DDL nodes to apply.
export { DestructiveMigrationError, diffSchemas } from "./migrate/diff.ts"
export type { DiffOptions, SchemaDef } from "./migrate/diff.ts"
export {
  applyMigration,
  MigrationRequiresDriverError,
  planMigration,
  runPlan,
} from "./migrate/runner.ts"
export type { ApplyResult, MigrationOptions, MigrationPlan } from "./migrate/runner.ts"
