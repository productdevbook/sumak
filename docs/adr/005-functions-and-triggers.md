# ADR 005 — Functions and triggers as typed code

**Status**: Phase 1 accepted; Phase 2 deferred with a sketched plan.
**Issue**: [#91](https://github.com/productdevbook/sumak/issues/91).
**Date**: 2026-05-20.

## Context

Issue [#91](https://github.com/productdevbook/sumak/issues/91) (@deslunes) frames a broader thesis: ORMs that own schemas and queries but leave **functions**, **triggers**, and **RLS** as raw SQL force users into a split workflow — half the DB lives in code, half lives in `*.sql` files run by a deploy script. The single source of truth breaks at exactly the layer where business logic is most tangled with data.

Sumak already shipped first-class **RLS** in PRs [#172](https://github.com/productdevbook/sumak/pull/172) and [#179](https://github.com/productdevbook/sumak/pull/179) — `CREATE POLICY`, `ALTER POLICY`, `DROP POLICY`, and the `AlterTableBuilder` toggles. This ADR addresses the remaining two surfaces.

The original proposal's example:

```ts
export const computeTaxes = pgFunction("compute_taxes")
  .args({
    price: numeric("price").notNull(),
    tax: numeric("tax").default(0.2),
  })
  .returns(numeric())
  .as((args, db) =>
    db
      .begin()
      .return(mul(args.price, add(1, args.tax)))
      .end(),
  )
```

Note what the body actually is: a single `RETURN expr;` wrapped in `BEGIN … END;`. **No control flow, no variable declarations, no error handling.** This is the most common shape for stored functions in practice (`compute_*`, `format_*`, `validate_*` helpers).

## Decision

Implement functions and triggers in **two phases**, with an AST and builder shape designed up front to accommodate both.

### Phase 1 (this ADR — implementation lands in a paired PR)

Scope:

1. **`CREATE FUNCTION`** with a typed expression body. The body is a single `Expression<T>` returned from a typed callback that receives the argument map as `Expression<...>` placeholders. Emitted as either `LANGUAGE SQL AS $$ SELECT <expr> $$` or `LANGUAGE plpgsql AS $$ BEGIN RETURN <expr>; END $$` depending on a builder flag.
2. **`CREATE TRIGGER`** as standalone DDL referencing a function by name. Full grammar — `BEFORE` / `AFTER` / `INSTEAD OF`, `INSERT` / `UPDATE` / `DELETE` (multiple), `FOR EACH ROW` / `STATEMENT`, optional `WHEN (condition)`.
3. **`DROP FUNCTION`** / **`DROP TRIGGER`**.
4. **Call-site type inference** — the value returned from `createFunction(...).build()` carries a typed `.call(args)` method that produces `Expression<ReturnType>`, usable inside any other query without dropping to a template literal.

PG-only for the first cut. MySQL / MSSQL have functions but their grammar diverges enough (return-type syntax, variable scoping, security clauses) to warrant separate dialect printers; SQLite has no `CREATE FUNCTION` at all (functions are registered through the C API).

### Phase 2 (deferred — sketched below for the next contributor)

Adds **procedural control flow**: `IF/THEN/ELSE/END IF`, `LOOP/WHILE/FOR/EXIT`, `RAISE EXCEPTION`, `RETURN NEXT` for set-returning, variable declarations (`DECLARE var TYPE := expr;`), and the plpgsql magic variables (`FOUND`, `NEW`, `OLD`, `TG_OP`).

Phase 2 should be additive — Phase 1 AST and call sites stay valid.

## Why this shape

### Why typed body, not raw SQL

A "raw SQL body" half-measure ships functions/triggers as **DDL plumbing** without solving the issue's actual ask: type safety over the body. If `computeTaxes("price", "tax")` is just a string template, none of the schema, none of the call sites, and none of the return-type inference get the benefits the proposal is asking for. We'd be declaring victory at the easy half and inheriting an escape hatch we'd later have to migrate away from.

The expression body is small enough to do right in Phase 1. The control-flow body is the hard part; Phase 2 owns it.

### Why one phase instead of all-of-plpgsql

The issue author themselves wrote:

> _"I think it would be hard to implement the whole set of keywords and syntax of plpgsql, but at the same time that's not really what I'm suggesting. I'm suggesting to partially implement it, with guardrails so that it stays simple and easy to read as code."_

Phase 1 IS the guardrail. The builder simply doesn't surface `.if(...)`, `.loop(...)`, `.raise(...)` yet — users who need them write raw SQL today and migrate to the typed surface when Phase 2 lands. Functions that fit Phase 1's shape are typed end-to-end from day one.

### Why call-site inference is part of Phase 1

A `CREATE FUNCTION` builder that doesn't produce a typed call wrapper is just DDL ergonomics. The whole point of "functions as code" is reusing the same definition both to **declare** and to **invoke** the function — `computeTaxes.call({ price: col("price"), tax: val(0.18) })` returning `Expression<number>` is what makes the schema-as-code thesis hold.

## Phase 1 design

### AST

Two new DDL nodes:

```ts
export interface CreateFunctionNode {
  type: "create_function"
  name: string
  orReplace?: boolean
  args: FunctionArg[]
  returns: string // SQL type name
  language: "sql" | "plpgsql"
  body: ExpressionNode // body is the RETURN expression
  // Optional clauses for completeness; defaults match PG.
  immutable?: boolean
  stable?: boolean
  strict?: boolean
  parallel?: "safe" | "restricted" | "unsafe"
  security?: "definer" | "invoker"
}

export interface FunctionArg {
  name: string
  type: string
  defaultValue?: ExpressionNode
  mode?: "IN" | "OUT" | "INOUT" | "VARIADIC" // IN by default
}

export interface DropFunctionNode {
  type: "drop_function"
  name: string
  argTypes?: string[] // PG requires these to disambiguate overloads
  ifExists?: boolean
  cascade?: boolean
}

export interface CreateTriggerNode {
  type: "create_trigger"
  name: string
  table: string
  timing: "BEFORE" | "AFTER" | "INSTEAD OF"
  events: ("INSERT" | "UPDATE" | "DELETE" | "TRUNCATE")[] // composable
  updateOf?: string[] // UPDATE OF (col, col)
  forEach: "ROW" | "STATEMENT"
  when?: ExpressionNode // optional WHEN (condition)
  functionName: string // EXECUTE FUNCTION fn(args)
  functionArgs?: ExpressionNode[] // most triggers take no args
  orReplace?: boolean
  constraint?: { deferrable?: boolean; initiallyDeferred?: boolean }
}

export interface DropTriggerNode {
  type: "drop_trigger"
  name: string
  table: string
  ifExists?: boolean
  cascade?: boolean
}
```

All four go into the `DDLNode` union. The `CreateFunctionNode.body` shape — `ExpressionNode` — is the **Phase 1 surface**. Phase 2 extends this to `ExpressionNode | StatementBlockNode` so the change is additive.

### Builder

```ts
db.schema
  .createFunction("compute_taxes")
  .args({
    price: arg("numeric"),
    tax: arg("numeric", { default: val(0.2) }),
  })
  .returns("numeric")
  .languageSql()
  .body(({ price, tax }) => mul(price, add(val(1), tax)))
  .build()
// Emits: CREATE FUNCTION "compute_taxes"(price numeric, tax numeric DEFAULT 0.20)
//        RETURNS numeric LANGUAGE sql AS $$ SELECT ("price" * (1 + "tax")) $$;
```

The `body` callback receives a typed argument map where each entry is `Expression<T>` (T inferred from the arg's SQL type via the existing `validateDataType`-aware mapping). The return value is `Expression<ReturnType>` — the type checker enforces it matches `.returns(...)`.

`.languageSql()` and `.languagePlpgsql()` are the two surface options. The default is `sql` for single-expression bodies; `.languagePlpgsql()` wraps the same body in `BEGIN RETURN ...; END`.

### Call-site inference

The result of `.build()` carries:

```ts
interface TypedFunction<Args, Ret> {
  node: CreateFunctionNode
  call(args: { [K in keyof Args]: Expression<Args[K]> }): Expression<Ret>
}
```

So:

```ts
const computeTaxes = db.schema
  .createFunction("compute_taxes")
  .args({ price: arg("numeric"), tax: arg("numeric", { default: val(0.2) }) })
  .returns("numeric")
  .languageSql()
  .body(({ price, tax }) => mul(price, add(val(1), tax)))
  .build()

db.selectFrom("products").select({
  withTax: computeTaxes.call({ price: typedCol("price"), tax: val(0.18) }),
})
// SELECT "compute_taxes"("price", $1) AS "withTax" FROM "products"
```

The typed call is the payoff: schema, body, and invocation all share one source of truth.

### Trigger builder

```ts
db.schema
  .createTrigger("audit_users_updated")
  .on("users")
  .afterUpdate("email", "phone") // UPDATE OF restricts to these columns
  .forEachRow()
  .when(sql`NEW."email" IS DISTINCT FROM OLD."email"`)
  .executeFunction("log_user_change")
  .build()
// Emits: CREATE TRIGGER "audit_users_updated" AFTER UPDATE OF "email", "phone"
//        ON "users" FOR EACH ROW
//        WHEN (NEW."email" IS DISTINCT FROM OLD."email")
//        EXECUTE FUNCTION "log_user_change"();
```

The `.when(...)` clause initially takes a raw `sql\`\``template because`NEW.`/`OLD.` references are plpgsql-only identifiers — Phase 2 will surface them as a typed proxy. Until then, the escape hatch is named.

### Printer

PG-only for Phase 1. The function printer emits:

- `CREATE [OR REPLACE] FUNCTION "name"(args)` with each arg as `[mode] "name" type [DEFAULT expr]`
- `RETURNS type`
- `LANGUAGE sql | plpgsql`
- Body: `AS $$ SELECT <expr> $$` for SQL, `AS $$ BEGIN RETURN <expr>; END $$` for plpgsql
- Optional clauses: `IMMUTABLE | STABLE | VOLATILE`, `STRICT`, `PARALLEL safe|restricted|unsafe`, `SECURITY DEFINER|INVOKER`

The body expression flows through the existing `BasePrinter.printExpression`, so column-quoting, parameter binding, and function-call casing all "just work" — including any other typed function call inside the body. (Calling `compute_total(price)` inside `compute_taxes`' body, for instance, prints as `"compute_total"("price")`.)

For triggers, no plpgsql happens — the printer just emits the DDL with the function name as a quoted identifier.

### Dialect support

`CREATE_FUNCTION` and `CREATE_TRIGGER` feature flags, both PG-only at Phase 1. MySQL has `CREATE FUNCTION` and `CREATE TRIGGER` but with different grammars (return type comes after parameter list, body is procedural-only with no `LANGUAGE SQL` form, trigger `FOR EACH ROW` is mandatory and `STATEMENT` form doesn't exist). MSSQL similar. SQLite has neither (only TRIGGER, with a different body shape).

Each non-PG dialect throws `UnsupportedDialectFeatureError` via the feature flag, with a hint at the dialect's analogous surface.

## Phase 2 sketch (deferred)

For the contributor who picks this up:

### AST extensions

```ts
export interface StatementBlockNode {
  type: "statement_block"
  declarations?: VariableDeclarationNode[]
  statements: StatementNode[]
}

export type StatementNode =
  | ReturnStatementNode
  | IfStatementNode
  | LoopStatementNode // WHILE/FOR/LOOP with optional condition
  | ExitStatementNode // EXIT/CONTINUE
  | RaiseStatementNode // RAISE EXCEPTION/NOTICE/WARNING with format string
  | AssignStatementNode // var := expr
  | PerformStatementNode // PERFORM expr (call without RETURN)
  | StatementBlockNode // nested BEGIN…END

export interface VariableDeclarationNode {
  name: string
  type: string
  default?: ExpressionNode
}
```

`CreateFunctionNode.body` becomes `ExpressionNode | StatementBlockNode`. Phase 1 callsites stay valid.

### Builder extensions

```ts
.body(({ price, tax, $vars }) => $block(
  $declare({ adjusted: $var("numeric", default: val(0)) }),
  $assign("adjusted", mul(price, add(val(1), tax))),
  $if(gt($vars.adjusted, val(1000)),
    $raise("EXCEPTION", "Adjusted price too high: %", $vars.adjusted),
    $return($vars.adjusted),
  ),
))
```

Names tentative. The key constraint: typed throughout — `$vars.adjusted` is `Expression<number>`, `$raise` parameters match the format string, return-type still enforced.

### plpgsql printer

A new printer subclass (or pluggable strategy) that takes a `StatementBlockNode` and emits the plpgsql body:

```
DECLARE
  "adjusted" numeric DEFAULT 0;
BEGIN
  "adjusted" := ("price" * (1 + "tax"));
  IF ("adjusted" > 1000) THEN
    RAISE EXCEPTION 'Adjusted price too high: %', "adjusted";
  ELSE
    RETURN "adjusted";
  END IF;
END
```

Not a separate dialect from the BasePrinter — same identifier quoting, same parameter handling. Just an additional `printStatement(StatementNode)` recursive walk.

### Magic variables

`NEW`, `OLD`, `TG_OP`, `TG_TABLE_NAME`, `FOUND` are tracked as scoped-to-trigger-body or scoped-to-function-body typed identifiers. Make them available through the builder's body callback so users get `NEW.email` typed as `Expression<string>` rather than a raw `sql\`\`` template.

## Alternatives considered

- **Raw-SQL function body (option B from the design discussion)**. Rejected — declares victory at the easy half, ships an escape hatch we'd have to deprecate. The issue is about typed bodies; a string body solves the wrong problem.
- **Full plpgsql in one go (option C)**. Rejected for scope — the AST + printer + magic-variable type system is multiple weeks of careful work. Splitting at the expression/control-flow boundary makes each piece reviewable.
- **Mirror Convex's "function-as-endpoint" model**. The issue mentions this approvingly, but Convex's model presupposes a server runtime that owns the database connection — fundamentally different deployment shape than sumak's "any driver, any deploy".

## Reversal trigger

Drop the typed-body approach if any of:

- Phase 1 review surfaces a type-system limitation that makes the call-site inference unsound for non-trivial function signatures (e.g. polymorphic / variadic / set-returning).
- Real-world usage shows >50% of function bodies need control flow on day one — that would mean Phase 1 is too restrictive and we should accelerate Phase 2.
- The maintenance cost of keeping the plpgsql printer in sync with PG's evolving grammar outweighs the benefit (unlikely — plpgsql is a stable language).
