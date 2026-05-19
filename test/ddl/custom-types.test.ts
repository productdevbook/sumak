import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  AlterTypeAddValueBuilder,
  AlterTypeRenameBuilder,
  AlterTypeRenameValueBuilder,
  CreateDomainBuilder,
  CreateTypeEnumBuilder,
  DropDomainBuilder,
  DropTypeBuilder,
} from "../../src/builder/ddl/custom-types.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { SecurityError, UnsupportedDialectFeatureError } from "../../src/errors.ts"
import {
  alterTypeAddValue,
  alterTypeRename,
  alterTypeRenameValue,
  createDomain,
  createTypeEnum,
  dropDomain,
  dropType,
  sql,
} from "../../src/index.ts"
import { DDLPrinter } from "../../src/printer/ddl.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "../integration/pglite-driver.ts"

const pg = sumak({ dialect: pgDialect(), tables: {} })
const my = sumak({ dialect: mysqlDialect(), tables: {} })
const sqlite = sumak({ dialect: sqliteDialect(), tables: {} })
const mssql = sumak({ dialect: mssqlDialect(), tables: {} })

// ─────────────────────────────────────────────────────────────────────
// CREATE TYPE AS ENUM
// ─────────────────────────────────────────────────────────────────────

describe("CREATE TYPE AS ENUM — builder shape", () => {
  it("createTypeEnum(name) seeds an empty values list", () => {
    const node = createTypeEnum("status").build()
    expect(node).toEqual({ type: "create_type_enum", name: "status", values: [] })
  })

  it(".values(rest...) accepts a rest list of strings", () => {
    const node = createTypeEnum("status").values("a", "b", "c").build()
    expect(node.values).toEqual(["a", "b", "c"])
  })

  it(".values(array) accepts a single string[] argument", () => {
    const node = createTypeEnum("status").values(["a", "b"]).build()
    expect(node.values).toEqual(["a", "b"])
  })

  it("each .values() call REPLACES the previous list (idempotent)", () => {
    // Calling `.values()` more than once replaces — the chain re-roots
    // the label set rather than appending. Matches the documented
    // behavior and prevents accidental duplication.
    const node = createTypeEnum("status").values("x").values("a", "b").build()
    expect(node.values).toEqual(["a", "b"])
  })

  it("builder is immutable — branching the chain returns independent nodes", () => {
    const a = createTypeEnum("status")
    const b = a.values("a", "b")
    expect(a.build().values).toEqual([])
    expect(b.build().values).toEqual(["a", "b"])
  })

  it("build() returns a fresh array (mutating it doesn't poison the builder)", () => {
    const b = createTypeEnum("status").values("a", "b")
    const node = b.build()
    node.values.push("c")
    expect(b.build().values).toEqual(["a", "b"])
  })
})

describe("CREATE TYPE AS ENUM — PG emission", () => {
  it("emits with multiple values", () => {
    const q = pg.compileDDL(createTypeEnum("order_status").values("pending", "paid").build())
    expect(q.sql).toBe(`CREATE TYPE "order_status" AS ENUM ('pending', 'paid')`)
    expect(q.params).toEqual([])
  })

  it("emits with a single value", () => {
    const q = pg.compileDDL(createTypeEnum("color").values("red").build())
    expect(q.sql).toBe(`CREATE TYPE "color" AS ENUM ('red')`)
  })

  it("emits an empty enum (PG accepts it, though it's rarely useful)", () => {
    const q = pg.compileDDL(createTypeEnum("empty").build())
    expect(q.sql).toBe(`CREATE TYPE "empty" AS ENUM ()`)
  })

  it("escapes single quotes in label values", () => {
    // A label like `O'Brien` must be doubled to `O''Brien` to survive
    // the splice into the SQL literal slot.
    const q = pg.compileDDL(createTypeEnum("name").values("O'Brien", "ok").build())
    expect(q.sql).toBe(`CREATE TYPE "name" AS ENUM ('O''Brien', 'ok')`)
  })

  it("escapes backslashes in label values (MySQL backslash-escape safety)", () => {
    // Doubled by escapeStringLiteral — defensive against PG running in a
    // mode that interprets backslashes.
    const q = pg.compileDDL(createTypeEnum("foo").values("a\\b").build())
    expect(q.sql).toBe(`CREATE TYPE "foo" AS ENUM ('a\\\\b')`)
  })

  it("preserves declared order (which is the sort order in PG)", () => {
    // The label order is load-bearing in PG — ORDER BY on an enum-typed
    // column sorts by the declared sequence, not lexicographic text.
    const q = pg.compileDDL(createTypeEnum("priority").values("high", "low", "medium").build())
    expect(q.sql).toBe(`CREATE TYPE "priority" AS ENUM ('high', 'low', 'medium')`)
  })
})

// ─────────────────────────────────────────────────────────────────────
// DROP TYPE
// ─────────────────────────────────────────────────────────────────────

describe("DROP TYPE — builder shape", () => {
  it("accepts a single name", () => {
    const node = dropType("foo").build()
    expect(node.names).toEqual(["foo"])
  })

  it("accepts an array of names", () => {
    const node = dropType(["a", "b"]).build()
    expect(node.names).toEqual(["a", "b"])
  })

  it("defensively copies the names array", () => {
    const src = ["a", "b"]
    const node = dropType(src).build()
    src.push("c")
    expect(node.names).toEqual(["a", "b"])
  })

  it("build() copies the names array each time", () => {
    const b = dropType(["a", "b"])
    const n = b.build()
    n.names.push("c")
    expect(b.build().names).toEqual(["a", "b"])
  })

  it("CASCADE → RESTRICT flips to RESTRICT (last call wins)", () => {
    const node = dropType("t").cascade().restrict().build()
    expect(node.cascade).toBeUndefined()
    expect(node.restrict).toBe(true)
  })

  it("RESTRICT → CASCADE flips to CASCADE (last call wins)", () => {
    const node = dropType("t").restrict().cascade().build()
    expect(node.restrict).toBeUndefined()
    expect(node.cascade).toBe(true)
  })
})

describe("DROP TYPE — PG emission", () => {
  it("emits the bare form", () => {
    const q = pg.compileDDL(dropType("status").build())
    expect(q.sql).toBe(`DROP TYPE "status"`)
  })

  it("emits IF EXISTS … CASCADE", () => {
    const q = pg.compileDDL(dropType("status").ifExists().cascade().build())
    expect(q.sql).toBe(`DROP TYPE IF EXISTS "status" CASCADE`)
  })

  it("emits RESTRICT", () => {
    const q = pg.compileDDL(dropType("status").restrict().build())
    expect(q.sql).toBe(`DROP TYPE "status" RESTRICT`)
  })

  it("emits a comma-separated list", () => {
    const q = pg.compileDDL(dropType(["a", "b", "c"]).build())
    expect(q.sql).toBe(`DROP TYPE "a", "b", "c"`)
  })

  it("emits IF EXISTS + list + CASCADE together", () => {
    const q = pg.compileDDL(dropType(["a", "b"]).ifExists().cascade().build())
    expect(q.sql).toBe(`DROP TYPE IF EXISTS "a", "b" CASCADE`)
  })

  it("hand-rolled AST with empty names list throws", () => {
    expect(() =>
      pg.compileDDL({
        type: "drop_type",
        names: [],
      }),
    ).toThrow(/at least one/i)
  })

  it("hand-rolled AST with both CASCADE and RESTRICT throws", () => {
    expect(() =>
      pg.compileDDL({
        type: "drop_type",
        names: ["foo"],
        cascade: true,
        restrict: true,
      }),
    ).toThrow(/mutually exclusive/i)
  })
})

// ─────────────────────────────────────────────────────────────────────
// CREATE DOMAIN
// ─────────────────────────────────────────────────────────────────────

describe("CREATE DOMAIN — builder shape", () => {
  it("createDomain(name) seeds an empty dataType", () => {
    const node = createDomain("d").build()
    expect(node).toMatchObject({ type: "create_domain", name: "d", dataType: "" })
  })

  it("createDomain(name, type) seeds the dataType", () => {
    const node = createDomain("d", "integer").build()
    expect(node.dataType).toBe("integer")
  })

  it(".dataType(type) sets/overrides the base type", () => {
    const node = createDomain("d").dataType("integer").build()
    expect(node.dataType).toBe("integer")
  })

  it(".notNull() sets the flag", () => {
    const node = createDomain("d", "integer").notNull().build()
    expect(node.notNull).toBe(true)
  })

  it(".defaultTo(sql) sets the expression", () => {
    const node = createDomain("d", "integer")
      .defaultTo(sql`0`)
      .build()
    expect(node.defaultExpression).toBeDefined()
  })

  it(".check(sql) sets the expression", () => {
    const node = createDomain("d", "integer")
      .check(sql<boolean>`VALUE > 0`)
      .build()
    expect(node.check).toBeDefined()
    expect(node.checkConstraintName).toBeUndefined()
  })

  it(".check(sql, name) records the constraint name too", () => {
    const node = createDomain("d", "integer")
      .check(sql<boolean>`VALUE > 0`, "positive_check")
      .build()
    expect(node.checkConstraintName).toBe("positive_check")
  })

  it("builder is immutable — branching returns independent nodes", () => {
    const a = createDomain("d", "integer")
    const b = a.notNull()
    expect(a.build().notNull).toBeUndefined()
    expect(b.build().notNull).toBe(true)
  })
})

describe("CREATE DOMAIN — PG emission", () => {
  it("bare form — name + dataType", () => {
    const q = pg.compileDDL(createDomain("d", "integer").build())
    expect(q.sql).toBe(`CREATE DOMAIN "d" AS integer`)
  })

  it("dataType set via .dataType() chain", () => {
    const q = pg.compileDDL(createDomain("d").dataType("integer").build())
    expect(q.sql).toBe(`CREATE DOMAIN "d" AS integer`)
  })

  it("NOT NULL", () => {
    const q = pg.compileDDL(createDomain("d", "integer").notNull().build())
    expect(q.sql).toBe(`CREATE DOMAIN "d" AS integer NOT NULL`)
  })

  it("DEFAULT", () => {
    const q = pg.compileDDL(
      createDomain("d", "integer")
        .defaultTo(sql`0`)
        .build(),
    )
    expect(q.sql).toBe(`CREATE DOMAIN "d" AS integer DEFAULT 0`)
  })

  it("CHECK", () => {
    const q = pg.compileDDL(
      createDomain("d", "integer")
        .check(sql<boolean>`VALUE > 0`)
        .build(),
    )
    expect(q.sql).toBe(`CREATE DOMAIN "d" AS integer CHECK (VALUE > 0)`)
  })

  it("CHECK with named constraint", () => {
    const q = pg.compileDDL(
      createDomain("d", "integer")
        .check(sql<boolean>`VALUE > 0`, "positive_check")
        .build(),
    )
    expect(q.sql).toBe(`CREATE DOMAIN "d" AS integer CONSTRAINT "positive_check" CHECK (VALUE > 0)`)
  })

  it("all options combined — DEFAULT + NOT NULL + named CHECK", () => {
    const q = pg.compileDDL(
      createDomain("positive_int", "integer")
        .defaultTo(sql`1`)
        .notNull()
        .check(sql<boolean>`VALUE > 0`, "positive_int_check")
        .build(),
    )
    expect(q.sql).toBe(
      `CREATE DOMAIN "positive_int" AS integer DEFAULT 1 NOT NULL ` +
        `CONSTRAINT "positive_int_check" CHECK (VALUE > 0)`,
    )
  })

  it("complex base type — varchar(120) survives validateDataType", () => {
    const q = pg.compileDDL(createDomain("short_text", "varchar(120)").notNull().build())
    expect(q.sql).toBe(`CREATE DOMAIN "short_text" AS varchar(120) NOT NULL`)
  })

  it("hand-rolled AST with empty dataType throws", () => {
    expect(() =>
      pg.compileDDL({
        type: "create_domain",
        name: "d",
        dataType: "",
      }),
    ).toThrow(/requires a base data type/i)
  })
})

// ─────────────────────────────────────────────────────────────────────
// DROP DOMAIN
// ─────────────────────────────────────────────────────────────────────

describe("DROP DOMAIN — builder + PG emission", () => {
  it("emits the bare form", () => {
    const q = pg.compileDDL(dropDomain("positive_int").build())
    expect(q.sql).toBe(`DROP DOMAIN "positive_int"`)
  })

  it("IF EXISTS", () => {
    const q = pg.compileDDL(dropDomain("positive_int").ifExists().build())
    expect(q.sql).toBe(`DROP DOMAIN IF EXISTS "positive_int"`)
  })

  it("CASCADE", () => {
    const q = pg.compileDDL(dropDomain("positive_int").cascade().build())
    expect(q.sql).toBe(`DROP DOMAIN "positive_int" CASCADE`)
  })

  it("RESTRICT", () => {
    const q = pg.compileDDL(dropDomain("positive_int").restrict().build())
    expect(q.sql).toBe(`DROP DOMAIN "positive_int" RESTRICT`)
  })

  it("multiple names", () => {
    const q = pg.compileDDL(dropDomain(["a", "b"]).build())
    expect(q.sql).toBe(`DROP DOMAIN "a", "b"`)
  })

  it("IF EXISTS + multiple + CASCADE", () => {
    const q = pg.compileDDL(dropDomain(["a", "b"]).ifExists().cascade().build())
    expect(q.sql).toBe(`DROP DOMAIN IF EXISTS "a", "b" CASCADE`)
  })

  it("CASCADE → RESTRICT flips to RESTRICT (last call wins)", () => {
    const node = dropDomain("d").cascade().restrict().build()
    expect(node.cascade).toBeUndefined()
    expect(node.restrict).toBe(true)
  })

  it("hand-rolled AST with empty names throws", () => {
    expect(() =>
      pg.compileDDL({
        type: "drop_domain",
        names: [],
      }),
    ).toThrow(/at least one/i)
  })

  it("hand-rolled AST with both CASCADE and RESTRICT throws", () => {
    expect(() =>
      pg.compileDDL({
        type: "drop_domain",
        names: ["foo"],
        cascade: true,
        restrict: true,
      }),
    ).toThrow(/mutually exclusive/i)
  })
})

// ─────────────────────────────────────────────────────────────────────
// ALTER TYPE … ADD VALUE
// ─────────────────────────────────────────────────────────────────────

describe("ALTER TYPE ADD VALUE — builder shape", () => {
  it("alterTypeAddValue(name) seeds an empty value", () => {
    const node = alterTypeAddValue("e").build()
    expect(node).toEqual({ type: "alter_type_add_value", name: "e", value: "" })
  })

  it(".value(v) sets the new label", () => {
    const node = alterTypeAddValue("e").value("x").build()
    expect(node.value).toBe("x")
  })

  it(".ifNotExists() sets the flag", () => {
    const node = alterTypeAddValue("e").value("x").ifNotExists().build()
    expect(node.ifNotExists).toBe(true)
  })

  it(".before(existing) sets the BEFORE position", () => {
    const node = alterTypeAddValue("e").value("x").before("y").build()
    expect(node.position).toEqual({ kind: "BEFORE", existing: "y" })
  })

  it(".after(existing) sets the AFTER position", () => {
    const node = alterTypeAddValue("e").value("x").after("y").build()
    expect(node.position).toEqual({ kind: "AFTER", existing: "y" })
  })

  it(".before() then .after() — last call wins (replaces position)", () => {
    const node = alterTypeAddValue("e").value("x").before("y").after("z").build()
    expect(node.position).toEqual({ kind: "AFTER", existing: "z" })
  })

  it(".after() then .before() — last call wins (replaces position)", () => {
    const node = alterTypeAddValue("e").value("x").after("z").before("y").build()
    expect(node.position).toEqual({ kind: "BEFORE", existing: "y" })
  })

  it("builder is immutable — branching returns independent nodes", () => {
    const a = alterTypeAddValue("e").value("x")
    const b = a.ifNotExists()
    expect(a.build().ifNotExists).toBeUndefined()
    expect(b.build().ifNotExists).toBe(true)
  })
})

describe("ALTER TYPE ADD VALUE — PG emission", () => {
  it("emits the plain form", () => {
    const q = pg.compileDDL(alterTypeAddValue("order_status").value("refunded").build())
    expect(q.sql).toBe(`ALTER TYPE "order_status" ADD VALUE 'refunded'`)
    expect(q.params).toEqual([])
  })

  it("emits IF NOT EXISTS", () => {
    const q = pg.compileDDL(
      alterTypeAddValue("order_status").value("refunded").ifNotExists().build(),
    )
    expect(q.sql).toBe(`ALTER TYPE "order_status" ADD VALUE IF NOT EXISTS 'refunded'`)
  })

  it("emits BEFORE", () => {
    const q = pg.compileDDL(alterTypeAddValue("order_status").value("x").before("paid").build())
    expect(q.sql).toBe(`ALTER TYPE "order_status" ADD VALUE 'x' BEFORE 'paid'`)
  })

  it("emits AFTER", () => {
    const q = pg.compileDDL(alterTypeAddValue("order_status").value("x").after("paid").build())
    expect(q.sql).toBe(`ALTER TYPE "order_status" ADD VALUE 'x' AFTER 'paid'`)
  })

  it("emits IF NOT EXISTS + AFTER together", () => {
    const q = pg.compileDDL(
      alterTypeAddValue("order_status").value("x").ifNotExists().after("paid").build(),
    )
    expect(q.sql).toBe(`ALTER TYPE "order_status" ADD VALUE IF NOT EXISTS 'x' AFTER 'paid'`)
  })

  it("escapes single quotes in the new value", () => {
    // A label like `O'Brien` must be doubled to `O''Brien` to survive
    // the splice into the SQL literal slot.
    const q = pg.compileDDL(alterTypeAddValue("names").value("O'Brien").build())
    expect(q.sql).toBe(`ALTER TYPE "names" ADD VALUE 'O''Brien'`)
  })

  it("escapes single quotes in the BEFORE / AFTER existing label too", () => {
    const q = pg.compileDDL(alterTypeAddValue("names").value("x").after("O'Brien").build())
    expect(q.sql).toBe(`ALTER TYPE "names" ADD VALUE 'x' AFTER 'O''Brien'`)
  })

  it("escapes backslashes in the new value", () => {
    const q = pg.compileDDL(alterTypeAddValue("foo").value("a\\b").build())
    expect(q.sql).toBe(`ALTER TYPE "foo" ADD VALUE 'a\\\\b'`)
  })

  it("hand-rolled AST with empty value throws", () => {
    expect(() =>
      pg.compileDDL({
        type: "alter_type_add_value",
        name: "e",
        value: "",
      }),
    ).toThrow(/requires a non-empty value/i)
  })

  it("hand-rolled AST with injected type name throws", () => {
    expect(() =>
      pg.compileDDL({
        type: "alter_type_add_value",
        name: "e; DROP TABLE users; --",
        value: "x",
      }),
    ).toThrow(SecurityError)
  })
})

// ─────────────────────────────────────────────────────────────────────
// ALTER TYPE RENAME
// ─────────────────────────────────────────────────────────────────────

describe("ALTER TYPE RENAME — builder shape", () => {
  it("alterTypeRename(name) seeds an empty target", () => {
    const node = alterTypeRename("e").build()
    expect(node).toEqual({ type: "alter_type_rename", name: "e", newName: "" })
  })

  it("alterTypeRename(name, newName) accepts the target up front", () => {
    const node = alterTypeRename("e", "f").build()
    expect(node).toEqual({ type: "alter_type_rename", name: "e", newName: "f" })
  })

  it(".to(newName) sets the target after construction", () => {
    const node = alterTypeRename("e").to("f").build()
    expect(node.newName).toBe("f")
  })

  it(".to(newName) overrides a constructor-supplied target — last call wins", () => {
    const node = alterTypeRename("e", "f").to("g").build()
    expect(node.newName).toBe("g")
  })

  it("builder is immutable — branching returns independent nodes", () => {
    const a = alterTypeRename("e")
    const b = a.to("f")
    expect(a.build().newName).toBe("")
    expect(b.build().newName).toBe("f")
  })
})

describe("ALTER TYPE RENAME — PG emission", () => {
  it("emits via the two-arg factory form", () => {
    const q = pg.compileDDL(alterTypeRename("order_status", "order_state").build())
    expect(q.sql).toBe(`ALTER TYPE "order_status" RENAME TO "order_state"`)
    expect(q.params).toEqual([])
  })

  it("emits via the chained .to() form", () => {
    const q = pg.compileDDL(alterTypeRename("order_status").to("order_state").build())
    expect(q.sql).toBe(`ALTER TYPE "order_status" RENAME TO "order_state"`)
  })

  it("quotes both names (identifier escape on edge-case names)", () => {
    // Both identifiers flow through `quoteIdentifier`. The unusual but
    // valid case below — a reserved word that's still a legal SQL
    // identifier — must come back double-quoted on both sides.
    const q = pg.compileDDL(alterTypeRename("user").to("account").build())
    expect(q.sql).toBe(`ALTER TYPE "user" RENAME TO "account"`)
  })

  it("hand-rolled AST with empty newName throws with a pointer at .to()", () => {
    expect(() =>
      pg.compileDDL({
        type: "alter_type_rename",
        name: "e",
        newName: "",
      }),
    ).toThrow(/requires a non-empty target name/i)
  })

  it("hand-rolled AST with injected source name throws", () => {
    expect(() =>
      pg.compileDDL({
        type: "alter_type_rename",
        name: "e; DROP TABLE users; --",
        newName: "f",
      }),
    ).toThrow(SecurityError)
  })

  it("hand-rolled AST with injected target name throws", () => {
    expect(() =>
      pg.compileDDL({
        type: "alter_type_rename",
        name: "e",
        newName: "f; DROP TABLE users; --",
      }),
    ).toThrow(SecurityError)
  })
})

// ─────────────────────────────────────────────────────────────────────
// ALTER TYPE RENAME VALUE
// ─────────────────────────────────────────────────────────────────────

describe("ALTER TYPE RENAME VALUE — builder shape", () => {
  it("alterTypeRenameValue(name) seeds empty old/new values", () => {
    const node = alterTypeRenameValue("e").build()
    expect(node).toEqual({
      type: "alter_type_rename_value",
      name: "e",
      oldValue: "",
      newValue: "",
    })
  })

  it(".from(v) sets the old label", () => {
    const node = alterTypeRenameValue("e").from("x").build()
    expect(node.oldValue).toBe("x")
  })

  it(".to(v) sets the new label", () => {
    const node = alterTypeRenameValue("e").to("y").build()
    expect(node.newValue).toBe("y")
  })

  it(".from(a).to(b) chains in either order", () => {
    const a = alterTypeRenameValue("e").from("x").to("y").build()
    const b = alterTypeRenameValue("e").to("y").from("x").build()
    expect(a).toEqual(b)
  })

  it("builder is immutable — branching returns independent nodes", () => {
    const base = alterTypeRenameValue("e").from("x")
    const branched = base.to("y")
    expect(base.build().newValue).toBe("")
    expect(branched.build().newValue).toBe("y")
  })
})

describe("ALTER TYPE RENAME VALUE — PG emission", () => {
  it("emits the plain form", () => {
    const q = pg.compileDDL(
      alterTypeRenameValue("order_status").from("paid").to("captured").build(),
    )
    expect(q.sql).toBe(`ALTER TYPE "order_status" RENAME VALUE 'paid' TO 'captured'`)
    expect(q.params).toEqual([])
  })

  it("escapes single quotes in the old label", () => {
    // The old label sits in a SQL literal slot — single quotes must
    // double through `escapeStringLiteral` exactly like ADD VALUE.
    const q = pg.compileDDL(alterTypeRenameValue("names").from("O'Brien").to("Smith").build())
    expect(q.sql).toBe(`ALTER TYPE "names" RENAME VALUE 'O''Brien' TO 'Smith'`)
  })

  it("escapes single quotes in the new label", () => {
    const q = pg.compileDDL(alterTypeRenameValue("names").from("alice").to("O'Brien").build())
    expect(q.sql).toBe(`ALTER TYPE "names" RENAME VALUE 'alice' TO 'O''Brien'`)
  })

  it("escapes single quotes on both sides simultaneously", () => {
    const q = pg.compileDDL(alterTypeRenameValue("names").from("O'Brien").to("O'Hara").build())
    expect(q.sql).toBe(`ALTER TYPE "names" RENAME VALUE 'O''Brien' TO 'O''Hara'`)
  })

  it("escapes backslashes", () => {
    const q = pg.compileDDL(alterTypeRenameValue("foo").from("a\\b").to("c\\d").build())
    expect(q.sql).toBe(`ALTER TYPE "foo" RENAME VALUE 'a\\\\b' TO 'c\\\\d'`)
  })

  it("hand-rolled AST with empty oldValue throws", () => {
    expect(() =>
      pg.compileDDL({
        type: "alter_type_rename_value",
        name: "e",
        oldValue: "",
        newValue: "y",
      }),
    ).toThrow(/requires a non-empty old value/i)
  })

  it("hand-rolled AST with empty newValue throws", () => {
    expect(() =>
      pg.compileDDL({
        type: "alter_type_rename_value",
        name: "e",
        oldValue: "x",
        newValue: "",
      }),
    ).toThrow(/requires a non-empty new value/i)
  })

  it("hand-rolled AST with injected type name throws", () => {
    expect(() =>
      pg.compileDDL({
        type: "alter_type_rename_value",
        name: "e; DROP TABLE users; --",
        oldValue: "x",
        newValue: "y",
      }),
    ).toThrow(SecurityError)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Dialect feature gate — PG only
// ─────────────────────────────────────────────────────────────────────

describe("CUSTOM_TYPES is PostgreSQL-only", () => {
  const createEnum = (db: typeof pg) =>
    db.compileDDL(db.schema.createTypeEnum("e").values("a").build())
  const dropEnum = (db: typeof pg) => db.compileDDL(db.schema.dropType("e").build())
  const createDom = (db: typeof pg) => db.compileDDL(db.schema.createDomain("d", "integer").build())
  const dropDom = (db: typeof pg) => db.compileDDL(db.schema.dropDomain("d").build())
  const alterAddVal = (db: typeof pg) =>
    db.compileDDL(db.schema.alterTypeAddValue("e").value("x").build())
  const alterRename = (db: typeof pg) => db.compileDDL(db.schema.alterTypeRename("e", "f").build())
  const alterRenameVal = (db: typeof pg) =>
    db.compileDDL(db.schema.alterTypeRenameValue("e").from("x").to("y").build())

  it("MySQL: CREATE TYPE AS ENUM refused", () => {
    expect(() => createEnum(my as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MySQL: DROP TYPE refused", () => {
    expect(() => dropEnum(my as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MySQL: CREATE DOMAIN refused", () => {
    expect(() => createDom(my as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MySQL: DROP DOMAIN refused", () => {
    expect(() => dropDom(my as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MySQL: ALTER TYPE ADD VALUE refused", () => {
    expect(() => alterAddVal(my as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MySQL: ALTER TYPE RENAME refused", () => {
    expect(() => alterRename(my as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MySQL: ALTER TYPE RENAME VALUE refused", () => {
    expect(() => alterRenameVal(my as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("SQLite: CREATE TYPE AS ENUM refused", () => {
    expect(() => createEnum(sqlite as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("SQLite: DROP TYPE refused", () => {
    expect(() => dropEnum(sqlite as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("SQLite: CREATE DOMAIN refused", () => {
    expect(() => createDom(sqlite as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("SQLite: DROP DOMAIN refused", () => {
    expect(() => dropDom(sqlite as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("SQLite: ALTER TYPE ADD VALUE refused", () => {
    expect(() => alterAddVal(sqlite as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("SQLite: ALTER TYPE RENAME refused", () => {
    expect(() => alterRename(sqlite as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("SQLite: ALTER TYPE RENAME VALUE refused", () => {
    expect(() => alterRenameVal(sqlite as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MSSQL: CREATE TYPE AS ENUM refused", () => {
    expect(() => createEnum(mssql as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MSSQL: DROP TYPE refused", () => {
    expect(() => dropEnum(mssql as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MSSQL: CREATE DOMAIN refused", () => {
    expect(() => createDom(mssql as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MSSQL: DROP DOMAIN refused", () => {
    expect(() => dropDom(mssql as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MSSQL: ALTER TYPE ADD VALUE refused", () => {
    expect(() => alterAddVal(mssql as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MSSQL: ALTER TYPE RENAME refused", () => {
    expect(() => alterRename(mssql as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MSSQL: ALTER TYPE RENAME VALUE refused", () => {
    expect(() => alterRenameVal(mssql as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("error message names the CUSTOM_TYPES feature", () => {
    try {
      createEnum(my as any)
      throw new Error("unreachable")
    } catch (e) {
      expect((e as Error).message).toMatch(/CREATE TYPE \/ CREATE DOMAIN/)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// Name validators
// ─────────────────────────────────────────────────────────────────────

describe("Name validators reject injection", () => {
  // The type / domain names land in `quoteIdentifier`'s output but the
  // builder also gates them through `validateFunctionName` to reject
  // any non-identifier shape — keeps hand-crafted ASTs honest.
  const printer = new DDLPrinter("pg")

  it("CREATE TYPE: rejects injected name", () => {
    expect(() =>
      printer.print({
        type: "create_type_enum",
        name: "x; DROP TABLE users; --",
        values: ["a"],
      }),
    ).toThrow(SecurityError)
  })

  it("DROP TYPE: rejects injected name in list", () => {
    expect(() =>
      printer.print({
        type: "drop_type",
        names: ["good", "evil; DROP TABLE users"],
      }),
    ).toThrow(SecurityError)
  })

  it("CREATE DOMAIN: rejects injected name", () => {
    expect(() =>
      printer.print({
        type: "create_domain",
        name: "x';DROP",
        dataType: "integer",
      }),
    ).toThrow(SecurityError)
  })

  it("CREATE DOMAIN: rejects injected data type", () => {
    expect(() =>
      printer.print({
        type: "create_domain",
        name: "d",
        dataType: "integer; DROP TABLE",
      }),
    ).toThrow(SecurityError)
  })

  it("CREATE DOMAIN: rejects injected CHECK constraint name", () => {
    expect(() =>
      printer.print({
        type: "create_domain",
        name: "d",
        dataType: "integer",
        check: { type: "raw", sql: "VALUE > 0", params: [] },
        checkConstraintName: "evil; DROP",
      }),
    ).toThrow(SecurityError)
  })

  it("CREATE TYPE: enum values are escape-safe (single quote doubled)", () => {
    const r = printer.print({
      type: "create_type_enum",
      name: "e",
      values: ["O'Brien"],
    })
    expect(r.sql).toBe(`CREATE TYPE "e" AS ENUM ('O''Brien')`)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Standalone builder direct construction
// ─────────────────────────────────────────────────────────────────────

describe("Standalone builder classes", () => {
  it("CreateTypeEnumBuilder is constructable directly", () => {
    const node = new CreateTypeEnumBuilder("e").values("a").build()
    expect(node).toEqual({ type: "create_type_enum", name: "e", values: ["a"] })
  })

  it("DropTypeBuilder accepts a single name", () => {
    const node = new DropTypeBuilder("e").build()
    expect(node.names).toEqual(["e"])
  })

  it("DropTypeBuilder accepts an array", () => {
    const node = new DropTypeBuilder(["a", "b"]).build()
    expect(node.names).toEqual(["a", "b"])
  })

  it("CreateDomainBuilder is constructable directly", () => {
    const node = new CreateDomainBuilder("d", "integer").notNull().build()
    expect(node).toMatchObject({
      type: "create_domain",
      name: "d",
      dataType: "integer",
      notNull: true,
    })
  })

  it("DropDomainBuilder is constructable directly", () => {
    const node = new DropDomainBuilder("d").ifExists().build()
    expect(node).toMatchObject({ type: "drop_domain", names: ["d"], ifExists: true })
  })

  it("AlterTypeAddValueBuilder is constructable directly", () => {
    const node = new AlterTypeAddValueBuilder("e").value("x").build()
    expect(node).toMatchObject({
      type: "alter_type_add_value",
      name: "e",
      value: "x",
    })
  })

  it("AlterTypeRenameBuilder is constructable directly (two-arg form)", () => {
    const node = new AlterTypeRenameBuilder("e", "f").build()
    expect(node).toMatchObject({ type: "alter_type_rename", name: "e", newName: "f" })
  })

  it("AlterTypeRenameBuilder is constructable directly (chained .to() form)", () => {
    const node = new AlterTypeRenameBuilder("e").to("f").build()
    expect(node).toMatchObject({ type: "alter_type_rename", name: "e", newName: "f" })
  })

  it("AlterTypeRenameValueBuilder is constructable directly", () => {
    const node = new AlterTypeRenameValueBuilder("e").from("x").to("y").build()
    expect(node).toMatchObject({
      type: "alter_type_rename_value",
      name: "e",
      oldValue: "x",
      newValue: "y",
    })
  })
})

// ─────────────────────────────────────────────────────────────────────
// db.compile() routes through DDL printer
// ─────────────────────────────────────────────────────────────────────

describe("db.compile() routes custom-type nodes through DDLPrinter", () => {
  it("CreateTypeEnumNode round-trips through compile()", () => {
    const node = pg.schema.createTypeEnum("e").values("a", "b").build()
    const q = pg.compile(node)
    expect(q.sql).toBe(`CREATE TYPE "e" AS ENUM ('a', 'b')`)
  })

  it("DropTypeNode round-trips through compile()", () => {
    const node = pg.schema.dropType("e").ifExists().build()
    const q = pg.compile(node)
    expect(q.sql).toBe(`DROP TYPE IF EXISTS "e"`)
  })

  it("CreateDomainNode round-trips through compile()", () => {
    const node = pg.schema.createDomain("d", "integer").notNull().build()
    const q = pg.compile(node)
    expect(q.sql).toBe(`CREATE DOMAIN "d" AS integer NOT NULL`)
  })

  it("DropDomainNode round-trips through compile()", () => {
    const node = pg.schema.dropDomain("d").ifExists().build()
    const q = pg.compile(node)
    expect(q.sql).toBe(`DROP DOMAIN IF EXISTS "d"`)
  })

  it("AlterTypeAddValueNode round-trips through compile()", () => {
    const node = pg.schema.alterTypeAddValue("e").value("x").build()
    const q = pg.compile(node)
    expect(q.sql).toBe(`ALTER TYPE "e" ADD VALUE 'x'`)
  })

  it("AlterTypeRenameNode round-trips through compile()", () => {
    const node = pg.schema.alterTypeRename("e", "f").build()
    const q = pg.compile(node)
    expect(q.sql).toBe(`ALTER TYPE "e" RENAME TO "f"`)
  })

  it("AlterTypeRenameValueNode round-trips through compile()", () => {
    const node = pg.schema.alterTypeRenameValue("e").from("x").to("y").build()
    const q = pg.compile(node)
    expect(q.sql).toBe(`ALTER TYPE "e" RENAME VALUE 'x' TO 'y'`)
  })
})

// ─────────────────────────────────────────────────────────────────────
// PGlite roundtrip — the emitted DDL parses + executes against a real
// PG parser. Covers the integration plane.
// ─────────────────────────────────────────────────────────────────────

describe("PGlite roundtrip — CREATE TYPE AS ENUM + CREATE DOMAIN", () => {
  let pgdb: PGlite
  let db: ReturnType<typeof sumak<{}>>

  beforeAll(async () => {
    pgdb = new PGlite()
    await pgdb.waitReady
    db = sumak({ dialect: pgDialect(), tables: {}, driver: pgliteDriver(pgdb) })
  })

  afterAll(async () => {
    await pgdb?.close()
  })

  it("creates an enum type, uses it as a column type, accepts/rejects values, drops it", async () => {
    // 1) Create the enum type.
    await pgdb.exec(
      db.compileDDL(
        db.schema.createTypeEnum("order_status").values("pending", "paid", "shipped").build(),
      ).sql,
    )

    // Verify it landed in pg_type.
    const typs = await pgdb.query<{ typname: string }>(
      `SELECT typname FROM pg_type WHERE typname = 'order_status'`,
    )
    expect(typs.rows.map((r) => r.typname)).toEqual(["order_status"])

    // 2) Use the enum as a column type and insert valid values.
    await pgdb.exec(`
      CREATE TEMP TABLE orders (
        id serial PRIMARY KEY,
        status order_status NOT NULL
      )
    `)
    await pgdb.exec(`INSERT INTO orders (status) VALUES ('pending'), ('paid')`)

    const ok = await pgdb.query<{ status: string }>(`SELECT status FROM orders ORDER BY id`)
    expect(ok.rows.map((r) => r.status)).toEqual(["pending", "paid"])

    // 3) Inserting a value outside the declared label set must fail —
    //    that's the entire point of an enum type.
    await expect(pgdb.exec(`INSERT INTO orders (status) VALUES ('cancelled')`)).rejects.toThrow(
      /invalid input value for enum/i,
    )

    // 4) Drop the table first (depends on the type), then the type.
    await pgdb.exec(`DROP TABLE orders`)
    await pgdb.exec(db.compileDDL(db.schema.dropType("order_status").build()).sql)

    // Verify the type is gone.
    const after = await pgdb.query<{ typname: string }>(
      `SELECT typname FROM pg_type WHERE typname = 'order_status'`,
    )
    expect(after.rows).toEqual([])
  })

  it("DROP TYPE IF EXISTS is idempotent", async () => {
    const sql = db.compileDDL(db.schema.dropType("never_existed").ifExists().build())
    await pgdb.exec(sql.sql)
    // Second drop must not throw either.
    await pgdb.exec(sql.sql)
  })

  it("creates a domain with CHECK, accepts/rejects values, drops it", async () => {
    // 1) Create the domain.
    await pgdb.exec(
      db.compileDDL(
        db.schema
          .createDomain("positive_int", "integer")
          .notNull()
          .check(sql<boolean>`VALUE > 0`, "positive_int_check")
          .build(),
      ).sql,
    )

    // 2) Use it as a column type.
    await pgdb.exec(`
      CREATE TEMP TABLE salaries (
        id serial PRIMARY KEY,
        amount positive_int
      )
    `)

    // 3) Valid insert.
    await pgdb.exec(`INSERT INTO salaries (amount) VALUES (100)`)
    const ok = await pgdb.query<{ amount: number }>(`SELECT amount FROM salaries ORDER BY id`)
    expect(ok.rows.map((r) => Number(r.amount))).toEqual([100])

    // 4) CHECK violation — must throw.
    await expect(pgdb.exec(`INSERT INTO salaries (amount) VALUES (-1)`)).rejects.toThrow(
      /violates check constraint/i,
    )

    // 5) NOT NULL violation — domain-level, must also throw.
    await expect(pgdb.exec(`INSERT INTO salaries (amount) VALUES (NULL)`)).rejects.toThrow(
      /domain positive_int does not allow null values|null value/i,
    )

    // 6) Cleanup.
    await pgdb.exec(`DROP TABLE salaries`)
    await pgdb.exec(db.compileDDL(db.schema.dropDomain("positive_int").build()).sql)
  })

  it("creates a domain with DEFAULT, the default is observed on insert", async () => {
    await pgdb.exec(
      db.compileDDL(
        db.schema
          .createDomain("age_dom", "integer")
          .defaultTo(sql`18`)
          .build(),
      ).sql,
    )

    await pgdb.exec(`
      CREATE TEMP TABLE people (
        id serial PRIMARY KEY,
        age age_dom
      )
    `)
    // Don't supply `age` — domain default should fire.
    await pgdb.exec(`INSERT INTO people (id) VALUES (DEFAULT)`)
    const r = await pgdb.query<{ age: number }>(`SELECT age FROM people`)
    expect(Number(r.rows[0]!.age)).toBe(18)

    await pgdb.exec(`DROP TABLE people`)
    await pgdb.exec(db.compileDDL(db.schema.dropDomain("age_dom").build()).sql)
  })

  // ALTER TYPE ADD VALUE — needs PG 12+ to run inside a transaction.
  // PGlite ships with PG 16, so the in-transaction case is fine here, but
  // tooling in the wild that targets PG 11 has to emit each statement
  // standalone (no surrounding BEGIN/COMMIT). The roundtrip below uses
  // `pgdb.exec(...)` straight, no explicit transaction, matching the
  // recommended migration pattern.
  it("ALTER TYPE ADD VALUE — appends a label, becomes a valid enum value", async () => {
    // Seed the type.
    await pgdb.exec(
      db.compileDDL(db.schema.createTypeEnum("flavor").values("vanilla", "chocolate").build()).sql,
    )

    // Extend with a third label.
    await pgdb.exec(
      db.compileDDL(db.schema.alterTypeAddValue("flavor").value("strawberry").build()).sql,
    )

    // Inserting the new label must succeed.
    await pgdb.exec(`
      CREATE TEMP TABLE cones (
        id serial PRIMARY KEY,
        f flavor NOT NULL
      )
    `)
    await pgdb.exec(`INSERT INTO cones (f) VALUES ('strawberry')`)
    const r = await pgdb.query<{ f: string }>(`SELECT f FROM cones`)
    expect(r.rows.map((row) => row.f)).toEqual(["strawberry"])

    // Cleanup.
    await pgdb.exec(`DROP TABLE cones`)
    await pgdb.exec(db.compileDDL(db.schema.dropType("flavor").build()).sql)
  })

  it("ALTER TYPE ADD VALUE BEFORE / AFTER orders the new label correctly", async () => {
    await pgdb.exec(
      db.compileDDL(db.schema.createTypeEnum("priority").values("low", "high").build()).sql,
    )

    // Insert `medium` between low and high.
    await pgdb.exec(
      db.compileDDL(db.schema.alterTypeAddValue("priority").value("medium").after("low").build())
        .sql,
    )

    // pg_enum.enumsortorder reflects the declared (and therefore ORDER BY)
    // order. Query it and assert the AFTER inserted into the middle.
    const rows = await pgdb.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum
        JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
       WHERE pg_type.typname = 'priority'
       ORDER BY enumsortorder`,
    )
    expect(rows.rows.map((row) => row.enumlabel)).toEqual(["low", "medium", "high"])

    await pgdb.exec(db.compileDDL(db.schema.dropType("priority").build()).sql)
  })

  it("ALTER TYPE ADD VALUE IF NOT EXISTS — idempotent on repeated apply", async () => {
    await pgdb.exec(
      db.compileDDL(db.schema.createTypeEnum("mood").values("happy", "sad").build()).sql,
    )

    const stmt = db.compileDDL(
      db.schema.alterTypeAddValue("mood").value("meh").ifNotExists().build(),
    ).sql

    // First apply adds the value.
    await pgdb.exec(stmt)
    // Second apply must be a no-op (no error).
    await pgdb.exec(stmt)

    const rows = await pgdb.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum
        JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
       WHERE pg_type.typname = 'mood'
       ORDER BY enumsortorder`,
    )
    expect(rows.rows.map((row) => row.enumlabel)).toEqual(["happy", "sad", "meh"])

    await pgdb.exec(db.compileDDL(db.schema.dropType("mood").build()).sql)
  })

  it("ALTER TYPE ADD VALUE — escaped single quote round-trips through PG", async () => {
    await pgdb.exec(db.compileDDL(db.schema.createTypeEnum("names").values("alice").build()).sql)
    await pgdb.exec(
      db.compileDDL(db.schema.alterTypeAddValue("names").value("O'Brien").build()).sql,
    )

    const rows = await pgdb.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum
        JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
       WHERE pg_type.typname = 'names'
       ORDER BY enumsortorder`,
    )
    expect(rows.rows.map((row) => row.enumlabel)).toEqual(["alice", "O'Brien"])

    await pgdb.exec(db.compileDDL(db.schema.dropType("names").build()).sql)
  })

  // ALTER TYPE RENAME — fully transactional. The roundtrip below renames
  // an enum that's already in use by a column, then asserts:
  //   1. The catalog tuple in pg_type reflects the new name.
  //   2. The old name no longer resolves.
  //   3. Stored rows survive the rename intact (PG resolves type refs
  //      by OID, not by name).
  //   4. The column declared against the old name can still be queried
  //      and accepts inserts under the new type name's alias.
  it("ALTER TYPE RENAME — renames the type, column reference still works", async () => {
    await pgdb.exec(
      db.compileDDL(db.schema.createTypeEnum("color_old").values("red", "green").build()).sql,
    )
    await pgdb.exec(`
      CREATE TEMP TABLE swatches (
        id serial PRIMARY KEY,
        c color_old NOT NULL
      )
    `)
    await pgdb.exec(`INSERT INTO swatches (c) VALUES ('red'), ('green')`)

    // Rename the type.
    await pgdb.exec(db.compileDDL(db.schema.alterTypeRename("color_old", "color_new").build()).sql)

    // The new name resolves; the old one does not.
    const present = await pgdb.query<{ typname: string }>(
      `SELECT typname FROM pg_type WHERE typname IN ('color_old', 'color_new')`,
    )
    expect(present.rows.map((r) => r.typname).sort()).toEqual(["color_new"])

    // Existing rows survived the rename — the column was bound to the
    // type by OID, not by name.
    const r = await pgdb.query<{ c: string }>(`SELECT c FROM swatches ORDER BY id`)
    expect(r.rows.map((row) => row.c)).toEqual(["red", "green"])

    // The column can now be used through the new type name as an alias —
    // a fresh insert via a cast to the renamed type lands fine.
    await pgdb.exec(`INSERT INTO swatches (c) VALUES ('red'::color_new)`)
    const after = await pgdb.query<{ c: string }>(`SELECT c FROM swatches ORDER BY id`)
    expect(after.rows.map((row) => row.c)).toEqual(["red", "green", "red"])

    await pgdb.exec(`DROP TABLE swatches`)
    await pgdb.exec(db.compileDDL(db.schema.dropType("color_new").build()).sql)
  })

  it("ALTER TYPE RENAME VALUE — relabels an enum value in place", async () => {
    await pgdb.exec(
      db.compileDDL(db.schema.createTypeEnum("paystate").values("pending", "paid").build()).sql,
    )
    await pgdb.exec(`
      CREATE TEMP TABLE bills (
        id serial PRIMARY KEY,
        s paystate NOT NULL
      )
    `)
    await pgdb.exec(`INSERT INTO bills (s) VALUES ('pending'), ('paid'), ('paid')`)

    await pgdb.exec(
      db.compileDDL(db.schema.alterTypeRenameValue("paystate").from("paid").to("captured").build())
        .sql,
    )

    // pg_enum reflects the new label. Stored rows take the new spelling
    // automatically — enum data is stored by OID, the rows that were
    // 'paid' are now 'captured' without an UPDATE.
    const labels = await pgdb.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum
        JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
       WHERE pg_type.typname = 'paystate'
       ORDER BY enumsortorder`,
    )
    expect(labels.rows.map((row) => row.enumlabel)).toEqual(["pending", "captured"])

    const rows = await pgdb.query<{ s: string }>(`SELECT s FROM bills ORDER BY id`)
    expect(rows.rows.map((row) => row.s)).toEqual(["pending", "captured", "captured"])

    // New inserts must use the new label.
    await pgdb.exec(`INSERT INTO bills (s) VALUES ('captured')`)
    // The old label no longer exists.
    await expect(pgdb.exec(`INSERT INTO bills (s) VALUES ('paid')`)).rejects.toThrow(
      /invalid input value for enum/i,
    )

    await pgdb.exec(`DROP TABLE bills`)
    await pgdb.exec(db.compileDDL(db.schema.dropType("paystate").build()).sql)
  })

  it("ALTER TYPE RENAME VALUE — escaped single quote round-trips through PG", async () => {
    await pgdb.exec(
      db.compileDDL(db.schema.createTypeEnum("vips").values("alice", "bob").build()).sql,
    )
    // Rename `alice` to `O'Brien` — the single quote in the new label
    // must survive the escape-and-splice round trip.
    await pgdb.exec(
      db.compileDDL(db.schema.alterTypeRenameValue("vips").from("alice").to("O'Brien").build()).sql,
    )

    const labels = await pgdb.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum
        JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
       WHERE pg_type.typname = 'vips'
       ORDER BY enumsortorder`,
    )
    expect(labels.rows.map((row) => row.enumlabel)).toEqual(["O'Brien", "bob"])

    await pgdb.exec(db.compileDDL(db.schema.dropType("vips").build()).sql)
  })
})
