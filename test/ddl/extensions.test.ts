import { PGlite } from "@electric-sql/pglite"
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { CreateExtensionBuilder, DropExtensionBuilder } from "../../src/builder/ddl/extension.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { SecurityError, UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { DDLPrinter } from "../../src/printer/ddl.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "../integration/pglite-driver.ts"

const pg = sumak({ dialect: pgDialect(), tables: {} })
const my = sumak({ dialect: mysqlDialect(), tables: {} })
const sqlite = sumak({ dialect: sqliteDialect(), tables: {} })
const mssql = sumak({ dialect: mssqlDialect(), tables: {} })

describe("CREATE EXTENSION — PostgreSQL", () => {
  it("emits the bare form", () => {
    const q = pg.compileDDL(pg.schema.createExtension("pgcrypto").build())
    expect(q.sql).toBe('CREATE EXTENSION "pgcrypto"')
    expect(q.params).toEqual([])
  })

  it("IF NOT EXISTS", () => {
    const q = pg.compileDDL(pg.schema.createExtension("btree_gist").ifNotExists().build())
    expect(q.sql).toBe('CREATE EXTENSION IF NOT EXISTS "btree_gist"')
  })

  it("SCHEMA", () => {
    const q = pg.compileDDL(pg.schema.createExtension("pg_trgm").schema("public").build())
    expect(q.sql).toBe('CREATE EXTENSION "pg_trgm" SCHEMA "public"')
  })

  it("VERSION (string literal, not identifier)", () => {
    // Versions are emitted as `'3.4.2'` — single-quoted string literal —
    // because PG `VERSION` accepts a string, not an identifier. The
    // dotted form is why the version validator is looser than the
    // identifier one.
    const q = pg.compileDDL(pg.schema.createExtension("postgis").version("3.4.2").build())
    expect(q.sql).toBe(`CREATE EXTENSION "postgis" VERSION '3.4.2'`)
  })

  it("CASCADE", () => {
    const q = pg.compileDDL(pg.schema.createExtension("postgis").cascade().build())
    expect(q.sql).toBe('CREATE EXTENSION "postgis" CASCADE')
  })

  it("all options combined — IF NOT EXISTS, SCHEMA, VERSION, CASCADE", () => {
    const q = pg.compileDDL(
      pg.schema
        .createExtension("postgis")
        .ifNotExists()
        .schema("public")
        .version("3.4.2")
        .cascade()
        .build(),
    )
    expect(q.sql).toBe(
      `CREATE EXTENSION IF NOT EXISTS "postgis" SCHEMA "public" VERSION '3.4.2' CASCADE`,
    )
  })

  it("hyphenated name (uuid-ossp) survives identifier quoting", () => {
    const q = pg.compileDDL(pg.schema.createExtension("uuid-ossp").build())
    // The hyphen would otherwise force PG to treat it as `uuid - ossp`,
    // so the identifier slot quoting is what makes this work.
    expect(q.sql).toBe('CREATE EXTENSION "uuid-ossp"')
  })

  it("builders are immutable (fluent clone)", () => {
    const a = pg.schema.createExtension("pgcrypto")
    const b = a.ifNotExists()
    const c = b.cascade()
    expect(a.build().ifNotExists).toBeUndefined()
    expect(b.build().ifNotExists).toBe(true)
    expect(b.build().cascade).toBeUndefined()
    expect(c.build().ifNotExists).toBe(true)
    expect(c.build().cascade).toBe(true)
  })
})

describe("DROP EXTENSION — PostgreSQL", () => {
  it("emits the bare form", () => {
    const q = pg.compileDDL(pg.schema.dropExtension("pgcrypto").build())
    expect(q.sql).toBe('DROP EXTENSION "pgcrypto"')
  })

  it("IF EXISTS", () => {
    const q = pg.compileDDL(pg.schema.dropExtension("pgcrypto").ifExists().build())
    expect(q.sql).toBe('DROP EXTENSION IF EXISTS "pgcrypto"')
  })

  it("CASCADE", () => {
    const q = pg.compileDDL(pg.schema.dropExtension("pgcrypto").cascade().build())
    expect(q.sql).toBe('DROP EXTENSION "pgcrypto" CASCADE')
  })

  it("RESTRICT (explicit default)", () => {
    const q = pg.compileDDL(pg.schema.dropExtension("pgcrypto").restrict().build())
    expect(q.sql).toBe('DROP EXTENSION "pgcrypto" RESTRICT')
  })

  it("multiple names (comma-separated)", () => {
    const q = pg.compileDDL(pg.schema.dropExtension(["pgcrypto", "uuid-ossp"]).build())
    expect(q.sql).toBe('DROP EXTENSION "pgcrypto", "uuid-ossp"')
  })

  it("IF EXISTS + multiple names + CASCADE", () => {
    const q = pg.compileDDL(
      pg.schema.dropExtension(["pgcrypto", "uuid-ossp"]).ifExists().cascade().build(),
    )
    expect(q.sql).toBe('DROP EXTENSION IF EXISTS "pgcrypto", "uuid-ossp" CASCADE')
  })

  it("calling cascade() then restrict() keeps only the most recent flag", () => {
    // The grammar treats CASCADE and RESTRICT as mutually exclusive.
    // The builder normalizes by clearing the other flag, so "last call
    // wins" gives you a printable node.
    const node = pg.schema.dropExtension("pgcrypto").cascade().restrict().build()
    expect(node.cascade).toBeUndefined()
    expect(node.restrict).toBe(true)
  })

  it("calling restrict() then cascade() flips the same way", () => {
    const node = pg.schema.dropExtension("pgcrypto").restrict().cascade().build()
    expect(node.restrict).toBeUndefined()
    expect(node.cascade).toBe(true)
  })

  it("hand-rolled AST with both CASCADE and RESTRICT throws", () => {
    expect(() =>
      pg.compileDDL({
        type: "drop_extension",
        names: ["pgcrypto"],
        cascade: true,
        restrict: true,
      }),
    ).toThrow(/mutually exclusive/i)
  })

  it("hand-rolled AST with empty names list throws", () => {
    expect(() =>
      pg.compileDDL({
        type: "drop_extension",
        names: [],
      }),
    ).toThrow(/at least one/i)
  })
})

describe("Extensions are PostgreSQL-only", () => {
  const create = (db: typeof pg) => db.compileDDL(db.schema.createExtension("pgcrypto").build())
  const drop = (db: typeof pg) => db.compileDDL(db.schema.dropExtension("pgcrypto").build())

  it("MySQL: CREATE EXTENSION refused", () => {
    expect(() => create(my as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MySQL: DROP EXTENSION refused", () => {
    expect(() => drop(my as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("SQLite: CREATE EXTENSION refused", () => {
    expect(() => create(sqlite as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("SQLite: DROP EXTENSION refused", () => {
    expect(() => drop(sqlite as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MSSQL: CREATE EXTENSION refused", () => {
    expect(() => create(mssql as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MSSQL: DROP EXTENSION refused", () => {
    expect(() => drop(mssql as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("error message names the EXTENSIONS feature", () => {
    try {
      create(my as any)
      throw new Error("unreachable")
    } catch (e) {
      expect((e as Error).message).toMatch(/CREATE\/DROP EXTENSION/)
    }
  })
})

describe("Extension-name validator rejects injection", () => {
  // Spliced verbatim into DDL, so any non-identifier shape opens an
  // injection path. The validator is what closes it.
  const printer = new DDLPrinter("pg")

  it('rejects "x; DROP TABLE users; --"', () => {
    expect(() =>
      printer.print({
        type: "create_extension",
        name: "x; DROP TABLE users; --",
      }),
    ).toThrow(SecurityError)
  })

  it("rejects a name with single quotes", () => {
    expect(() =>
      printer.print({
        type: "create_extension",
        name: "x' OR '1'='1",
      }),
    ).toThrow(SecurityError)
  })

  it("rejects a name with whitespace", () => {
    expect(() =>
      printer.print({
        type: "create_extension",
        name: "pg crypto",
      }),
    ).toThrow(SecurityError)
  })

  it("rejects an empty string", () => {
    expect(() =>
      printer.print({
        type: "create_extension",
        name: "",
      }),
    ).toThrow(SecurityError)
  })

  it("accepts a hyphenated identifier (uuid-ossp)", () => {
    const r = printer.print({ type: "create_extension", name: "uuid-ossp" })
    expect(r.sql).toBe('CREATE EXTENSION "uuid-ossp"')
  })

  it("rejects an injected name on DROP EXTENSION too", () => {
    expect(() =>
      printer.print({
        type: "drop_extension",
        names: ["good", "evil; DROP TABLE users"],
      }),
    ).toThrow(SecurityError)
  })
})

describe("Extension-version validator rejects injection", () => {
  const printer = new DDLPrinter("pg")

  it("accepts semver-ish (3.4.2)", () => {
    const r = printer.print({ type: "create_extension", name: "x", version: "3.4.2" })
    expect(r.sql).toBe(`CREATE EXTENSION "x" VERSION '3.4.2'`)
  })

  it("accepts hyphenated (1.1-rc1)", () => {
    const r = printer.print({ type: "create_extension", name: "x", version: "1.1-rc1" })
    expect(r.sql).toBe(`CREATE EXTENSION "x" VERSION '1.1-rc1'`)
  })

  it("rejects a version with single quotes", () => {
    expect(() =>
      printer.print({ type: "create_extension", name: "x", version: "1.0'; DROP" }),
    ).toThrow(SecurityError)
  })

  it("rejects a version with whitespace", () => {
    expect(() =>
      printer.print({ type: "create_extension", name: "x", version: "1.0 OR 1=1" }),
    ).toThrow(SecurityError)
  })

  it("rejects an empty version", () => {
    expect(() => printer.print({ type: "create_extension", name: "x", version: "" })).toThrow(
      SecurityError,
    )
  })
})

describe("db.compile() routes Create/DropExtensionNode through DDLPrinter", () => {
  it("CreateExtensionNode round-trips through compile()", () => {
    const node = pg.schema.createExtension("btree_gist").ifNotExists().build()
    const q = pg.compile(node)
    expect(q.sql).toBe('CREATE EXTENSION IF NOT EXISTS "btree_gist"')
  })

  it("DropExtensionNode round-trips through compile()", () => {
    const node = pg.schema.dropExtension("btree_gist").ifExists().build()
    const q = pg.compile(node)
    expect(q.sql).toBe('DROP EXTENSION IF EXISTS "btree_gist"')
  })
})

describe("Standalone builder classes", () => {
  it("CreateExtensionBuilder is constructable directly", () => {
    const node = new CreateExtensionBuilder("pgcrypto").ifNotExists().build()
    expect(node).toEqual({ type: "create_extension", name: "pgcrypto", ifNotExists: true })
  })

  it("DropExtensionBuilder accepts a single name", () => {
    const node = new DropExtensionBuilder("pgcrypto").build()
    expect(node.names).toEqual(["pgcrypto"])
  })

  it("DropExtensionBuilder accepts an array of names", () => {
    const node = new DropExtensionBuilder(["a", "b"]).build()
    expect(node.names).toEqual(["a", "b"])
  })

  it("DropExtensionBuilder array is defensively copied", () => {
    const src = ["a", "b"]
    const node = new DropExtensionBuilder(src).build()
    src.push("c")
    expect(node.names).toEqual(["a", "b"])
  })
})

describe("PGlite roundtrip — btree_gist", () => {
  // PGlite ships `btree_gist` as a bundled extension. Use it to prove
  // the emitted SQL actually loads through a real Postgres parser; if
  // anything in the grammar is off (missing space, wrong quoting),
  // PGlite would reject at parse time.
  let pgdb: PGlite
  let db: ReturnType<typeof sumak<{}>>

  beforeAll(async () => {
    // PGlite ships extensions as separate npm sub-paths — load
    // `btree_gist` via the `extensions: { btree_gist }` option so
    // `CREATE EXTENSION btree_gist` is resolvable. Without this
    // PGlite's bundled extension list contains only `plpgsql`.
    pgdb = new PGlite({ extensions: { btree_gist } })
    await pgdb.waitReady
    db = sumak({ dialect: pgDialect(), tables: {}, driver: pgliteDriver(pgdb) })
  })

  afterAll(async () => {
    await pgdb?.close()
  })

  it("CREATE EXTENSION IF NOT EXISTS btree_gist; load; DROP EXTENSION", async () => {
    // Create — first call installs it.
    const createSql = db.compileDDL(db.schema.createExtension("btree_gist").ifNotExists().build())
    await pgdb.exec(createSql.sql)

    // Confirm the extension is loaded via the pg_extension catalog.
    const loaded = await pgdb.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname = 'btree_gist'`,
    )
    expect(loaded.rows.map((r) => r.extname)).toEqual(["btree_gist"])

    // Functional check: btree_gist enables an EXCLUDE constraint using
    // the `=` operator on a btree-only type combined with a gist
    // operator class. If the extension didn't actually load, the next
    // statement throws "operator class … does not exist for access
    // method gist".
    await pgdb.exec(`
      CREATE TEMP TABLE rooms (
        room_id int,
        during tstzrange,
        EXCLUDE USING gist (room_id WITH =, during WITH &&)
      )
    `)

    // Drop — second call removes it.
    const dropSql = db.compileDDL(db.schema.dropExtension("btree_gist").cascade().build())
    await pgdb.exec(dropSql.sql)

    const stillThere = await pgdb.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname = 'btree_gist'`,
    )
    expect(stillThere.rows).toEqual([])
  })

  it("IF EXISTS makes drop idempotent", async () => {
    // No-op when the extension isn't there — should not throw.
    const sql = db.compileDDL(db.schema.dropExtension("btree_gist").ifExists().build())
    await pgdb.exec(sql.sql)
  })

  it("pg_available_extensions lists btree_gist as installable", async () => {
    // Sanity check: PGlite ships it. If a future PGlite drops the
    // bundle the roundtrip test above would fail with a useful diagnostic.
    const r = await pgdb.query<{ name: string }>(
      `SELECT name FROM pg_available_extensions WHERE name = 'btree_gist'`,
    )
    expect(r.rows.length).toBe(1)
  })
})
