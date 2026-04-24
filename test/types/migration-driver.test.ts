import { describe, expectTypeOf, it } from "vitest"

import type { Driver, DriverCallOptions, QueryEvent } from "../../src/driver/types.ts"
import type {
  IntrospectedColumn,
  IntrospectedConstraints,
  IntrospectedIndex,
  IntrospectedSchema,
  IntrospectedTable,
} from "../../src/introspect/types.ts"
import type { DestructiveMigrationError, DiffOptions, SchemaDef } from "../../src/migrate/diff.ts"
import type { ApplyResult, MigrationPlan } from "../../src/migrate/runner.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { defineTable } from "../../src/schema/table.ts"

// Migration / introspection / driver types aren't used via builders —
// users import them directly. These assertions pin the public surface.

describe("SchemaDef — accepts raw map, defineTable, or NormalizedTable", () => {
  it("raw columns entry is valid", () => {
    const s: SchemaDef = {
      users: { id: serial().primaryKey(), name: text().notNull() },
    }
    void s
  })

  it("defineTable wrapper entry is valid", () => {
    const s: SchemaDef = {
      users: defineTable("users", {
        id: serial().primaryKey(),
        name: text().notNull(),
      }),
    }
    void s
  })

  it("pre-normalized `{ columns, constraints? }` entry is valid", () => {
    const s: SchemaDef = {
      users: {
        columns: { id: serial().primaryKey() },
        constraints: { checks: [{ expression: "id > 0" }] },
      },
    }
    void s
  })

  it("all three forms can mix in one SchemaDef", () => {
    const s: SchemaDef = {
      a: { id: serial().primaryKey() },
      b: defineTable("b", { id: serial().primaryKey() }),
      c: { columns: { id: serial().primaryKey() } },
    }
    void s
  })
})

describe("DiffOptions — boolean | 'ignore' for allowDestructive", () => {
  it("true / false / 'ignore' are all valid", () => {
    const a: DiffOptions = { allowDestructive: true }
    const b: DiffOptions = { allowDestructive: false }
    const c: DiffOptions = { allowDestructive: "ignore" }
    void (a.allowDestructive satisfies boolean | "ignore" | undefined)
    void b
    void c
  })
})

describe("Driver contract — options third arg, signal optional", () => {
  it("query/execute accept (sql, params, options?)", () => {
    const d: Driver = {
      async query(_sql, _params, options) {
        expectTypeOf(options).toEqualTypeOf<DriverCallOptions | undefined>()
        return []
      },
      async execute(_sql, _params, options) {
        expectTypeOf(options).toEqualTypeOf<DriverCallOptions | undefined>()
        return { affected: 0 }
      },
    }
    void d
  })

  it("DriverCallOptions exposes optional signal", () => {
    expectTypeOf<DriverCallOptions["signal"]>().toEqualTypeOf<AbortSignal | undefined>()
  })
})

describe("Introspection — recovered constraints and indexes", () => {
  it("IntrospectedTable carries optional constraints + indexes", () => {
    const t: IntrospectedTable = {
      name: "users",
      columns: [],
    }
    expectTypeOf(t.constraints).toEqualTypeOf<IntrospectedConstraints | undefined>()
    expectTypeOf(t.indexes).toEqualTypeOf<readonly IntrospectedIndex[] | undefined>()
  })

  it("IntrospectedConstraints matches the defineTable DSL shape", () => {
    const c: IntrospectedConstraints = {
      primaryKey: { columns: ["id"] },
      uniques: [{ name: "uq", columns: ["a", "b"] }],
      checks: [{ name: "ck", expression: "price > 0" }],
    }
    void c
  })

  it("IntrospectedSchema.dialect is the four-way union", () => {
    expectTypeOf<IntrospectedSchema["dialect"]>().toEqualTypeOf<
      "pg" | "mysql" | "sqlite" | "mssql"
    >()
  })

  it("IntrospectedColumn carries dataType and nullable", () => {
    const c: IntrospectedColumn = {
      name: "id",
      dataType: "integer",
      nullable: false,
      isPrimaryKey: true,
      isUnique: false,
    }
    void c
  })
})

describe("Migration results — ApplyResult, MigrationPlan", () => {
  it("ApplyResult has `applied` and `statements`", () => {
    const r: ApplyResult = { applied: 3, statements: ["CREATE TABLE ..."] }
    expectTypeOf(r.applied).toEqualTypeOf<number>()
    expectTypeOf(r.statements).toEqualTypeOf<readonly string[]>()
  })

  it("MigrationPlan carries AST nodes, compiled steps, and a destructive flag", () => {
    // The public MigrationPlan contract — driver-less callers can
    // inspect the plan before applying. Locking the field names prevents
    // a rename from slipping out.
    expectTypeOf<MigrationPlan["hasDestructiveSteps"]>().toEqualTypeOf<boolean>()
    expectTypeOf<keyof MigrationPlan>().toEqualTypeOf<"nodes" | "steps" | "hasDestructiveSteps">()
  })

  it("DestructiveMigrationError is an Error subclass", () => {
    // The class itself is value-space; we check the instance shape.
    const err = new (class extends (Error as unknown as {
      new (msg: string): DestructiveMigrationError
    }) {})("test")
    expectTypeOf(err).toMatchTypeOf<Error>()
  })
})

describe("QueryEvent.id correlation", () => {
  it("id is `number` across all three phases", () => {
    expectTypeOf<QueryEvent["id"]>().toEqualTypeOf<number>()
  })
})
