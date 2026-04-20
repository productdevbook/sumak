import { describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: { id: serial().primaryKey(), name: text().notNull() },
    "audit.logs": { id: serial().primaryKey(), message: text().notNull() },
    "tenant_42.orders": { id: serial().primaryKey(), total: integer() },
  } as any,
})

describe("Dotted-key table names — schema-qualified SELECT", () => {
  it("unqualified table name renders without schema", () => {
    const q = (db.selectFrom as any)("users").select("id").toSQL()
    expect(q.sql).toMatch(/FROM "users"/)
  })

  it('"audit.logs" parses as schema="audit" name="logs"', () => {
    const q = (db.selectFrom as any)("audit.logs").select("id").toSQL()
    expect(q.sql).toMatch(/FROM "audit"\."logs"/)
  })

  it("dotted-key INSERT INTO targets the correct schema", () => {
    const q = (db.insertInto as any)("audit.logs").values({ message: "hi" }).toSQL()
    expect(q.sql).toMatch(/INSERT INTO "audit"\."logs"/)
  })

  it("dotted-key UPDATE targets the correct schema", () => {
    const q = (db.update as any)("audit.logs")
      .set({ message: "x" })
      .where(({ id }: any) => id.eq(1))
      .toSQL()
    expect(q.sql).toMatch(/UPDATE "audit"\."logs"/)
  })

  it("dotted-key DELETE FROM targets the correct schema", () => {
    const q = (db.deleteFrom as any)("audit.logs")
      .where(({ id }: any) => id.eq(1))
      .toSQL()
    expect(q.sql).toMatch(/DELETE FROM "audit"\."logs"/)
  })

  it("multi-dot strings are left as flat names (no second-level parse)", () => {
    const q = (db.selectFrom as any)("a.b.c").select("id").toSQL()
    // Treated as a single literal table name — no silent misparse.
    expect(q.sql).toContain('"a.b.c"')
  })
})

describe("db.withSchema() — scoped proxy", () => {
  const scoped = db.withSchema("tenant_42")

  it("prefixes unqualified SELECT", () => {
    const q = (scoped.selectFrom as any)("users").select("id").toSQL()
    expect(q.sql).toMatch(/FROM "tenant_42"\."users"/)
  })

  it("leaves already-qualified names alone", () => {
    const q = (scoped.selectFrom as any)("audit.logs").select("id").toSQL()
    expect(q.sql).toMatch(/FROM "audit"\."logs"/)
    expect(q.sql).not.toContain("tenant_42")
  })

  it("scope is per-call, not per-instance — parent db untouched", () => {
    const q = (db.selectFrom as any)("users").select("id").toSQL()
    expect(q.sql).toMatch(/FROM "users"/)
    expect(q.sql).not.toContain("tenant_42")
  })

  it("covers insert/update/delete too", () => {
    const i = (scoped.insertInto as any)("users").values({ name: "a" }).toSQL()
    expect(i.sql).toMatch(/INSERT INTO "tenant_42"\."users"/)

    const u = (scoped.update as any)("users")
      .set({ name: "b" })
      .where(({ id }: any) => id.eq(1))
      .toSQL()
    expect(u.sql).toMatch(/UPDATE "tenant_42"\."users"/)

    const d = (scoped.deleteFrom as any)("users")
      .where(({ id }: any) => id.eq(1))
      .toSQL()
    expect(d.sql).toMatch(/DELETE FROM "tenant_42"\."users"/)
  })
})

describe("parseTableRef edge cases", () => {
  it('trailing dot "users." throws (would otherwise emit broken SQL)', () => {
    expect(() => (db.selectFrom as any)("users.")).toThrow(/Invalid table identifier/i)
  })

  it('leading dot ".users" throws', () => {
    expect(() => (db.selectFrom as any)(".users")).toThrow(/Invalid table identifier/i)
  })

  it('just a dot "." throws', () => {
    expect(() => (db.selectFrom as any)(".")).toThrow(/Invalid table identifier/i)
  })
})

describe("db.compile() routes CREATE/DROP SCHEMA through DDLPrinter", () => {
  it("compile() on a CreateSchemaNode emits the DDL SQL (not a crash)", () => {
    const node = db.schema.createSchema("audit").ifNotExists().build()
    const q = db.compile(node)
    expect(q.sql).toBe('CREATE SCHEMA IF NOT EXISTS "audit"')
  })

  it("compile() on a DropSchemaNode emits the DDL SQL (not a crash)", () => {
    const node = db.schema.dropSchema("audit").ifExists().cascade().build()
    const q = db.compile(node)
    expect(q.sql).toBe('DROP SCHEMA IF EXISTS "audit" CASCADE')
  })
})

describe("CREATE SCHEMA / DROP SCHEMA DDL", () => {
  it("CREATE SCHEMA name", () => {
    const q = db.compileDDL(db.schema.createSchema("audit").build())
    expect(q.sql).toBe('CREATE SCHEMA "audit"')
  })

  it("CREATE SCHEMA IF NOT EXISTS", () => {
    const q = db.compileDDL(db.schema.createSchema("audit").ifNotExists().build())
    expect(q.sql).toBe('CREATE SCHEMA IF NOT EXISTS "audit"')
  })

  it("CREATE SCHEMA AUTHORIZATION", () => {
    const q = db.compileDDL(db.schema.createSchema("t").authorization("app_user").build())
    expect(q.sql).toBe('CREATE SCHEMA "t" AUTHORIZATION "app_user"')
  })

  it("DROP SCHEMA name", () => {
    const q = db.compileDDL(db.schema.dropSchema("audit").build())
    expect(q.sql).toBe('DROP SCHEMA "audit"')
  })

  it("DROP SCHEMA IF EXISTS CASCADE", () => {
    const q = db.compileDDL(db.schema.dropSchema("audit").ifExists().cascade().build())
    expect(q.sql).toBe('DROP SCHEMA IF EXISTS "audit" CASCADE')
  })
})
