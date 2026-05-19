import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { col, eq, gt, param } from "../../src/ast/expression.ts"
import { MergeBuilder } from "../../src/builder/merge.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { MssqlPrinter } from "../../src/printer/mssql.ts"
import { PgPrinter } from "../../src/printer/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

function pgPrinter() {
  return new PgPrinter()
}

function mssqlPrinter() {
  return new MssqlPrinter()
}

// ─── AST + printer surface ───────────────────────────────────────────

describe("MergeBuilder — WHEN NOT MATCHED BY SOURCE (printer surface)", () => {
  it("PG: WHEN NOT MATCHED BY SOURCE THEN DELETE", () => {
    const node = new MergeBuilder()
      .into("users")
      .using("staging", "s")
      .on(eq(col("id", "users"), col("id", "s")))
      .whenNotMatchedBySourceDelete()
      .build()

    const r = pgPrinter().print(node)
    expect(r.sql).toContain("WHEN NOT MATCHED BY SOURCE THEN DELETE")
    expect(r.sql).not.toContain("BY TARGET")
  })

  it("PG: WHEN NOT MATCHED BY SOURCE THEN UPDATE SET …", () => {
    const node = new MergeBuilder()
      .into("users")
      .using("staging", "s")
      .on(eq(col("id", "users"), col("id", "s")))
      .whenNotMatchedBySourceUpdate([{ column: "status", value: param(0, "archived") }])
      .build()

    const r = pgPrinter().print(node)
    expect(r.sql).toContain("WHEN NOT MATCHED BY SOURCE THEN UPDATE SET")
    expect(r.sql).toContain('"status" = $1')
    expect(r.params).toEqual(["archived"])
  })

  it("PG: WHEN NOT MATCHED BY SOURCE AND <cond> THEN UPDATE / DELETE", () => {
    const node = new MergeBuilder()
      .into("users")
      .using("staging", "s")
      .on(eq(col("id", "users"), col("id", "s")))
      .whenNotMatchedBySourceUpdate(
        [{ column: "status", value: param(0, "archived") }],
        eq(col("status", "users"), param(1, "active")),
      )
      .whenNotMatchedBySourceDelete(gt(col("score", "users"), param(2, 100)))
      .build()

    const r = pgPrinter().print(node)
    // PG printer renumbers params in emission order; conditions are
    // emitted before the SET clause so they get the lower numbers.
    expect(r.sql).toContain(
      'WHEN NOT MATCHED BY SOURCE AND ("users"."status" = $1) THEN UPDATE SET "status" = $2',
    )
    expect(r.sql).toContain('WHEN NOT MATCHED BY SOURCE AND ("users"."score" > $3) THEN DELETE')
    // Param order in the wire: condition for UPDATE (active), set value
    // (archived), condition for DELETE (100).
    expect(r.params).toEqual(["active", "archived", 100])
  })

  it("PG: all three branches (matched / not_matched / not_matched_by_source) compose", () => {
    const node = new MergeBuilder()
      .into("users")
      .using("staging", "s")
      .on(eq(col("id", "users"), col("id", "s")))
      .whenMatchedUpdate([{ column: "name", value: col("name", "s") }])
      .whenNotMatchedInsert(["id", "name"], [col("id", "s"), col("name", "s")])
      .whenNotMatchedBySourceDelete()
      .build()

    const r = pgPrinter().print(node)
    // Order matters: emit in builder order so the SQL author can reason
    // about which branch wins on overlap (PG/MSSQL both pick the first
    // matching branch top-to-bottom).
    expect(r.sql).toMatch(
      /WHEN MATCHED THEN UPDATE SET.*WHEN NOT MATCHED THEN INSERT.*WHEN NOT MATCHED BY SOURCE THEN DELETE/s,
    )
  })

  it("MSSQL: WHEN NOT MATCHED BY SOURCE THEN DELETE (same surface)", () => {
    const node = new MergeBuilder()
      .into("users")
      .using("staging", "s")
      .on(eq(col("id", "users"), col("id", "s")))
      .whenMatchedUpdate([{ column: "name", value: param(0, "Bob") }])
      .whenNotMatchedBySourceDelete()
      .build()

    const r = mssqlPrinter().print(node)
    expect(r.sql).toContain("[users]")
    expect(r.sql).toContain("[staging]")
    expect(r.sql).toContain("WHEN NOT MATCHED BY SOURCE THEN DELETE")
    expect(r.params).toEqual(["Bob"])
  })

  it("MSSQL: WHEN NOT MATCHED BY SOURCE AND … THEN UPDATE SET …", () => {
    const node = new MergeBuilder()
      .into("users")
      .using("staging", "s")
      .on(eq(col("id", "users"), col("id", "s")))
      .whenNotMatchedBySourceUpdate(
        [{ column: "status", value: param(0, "archived") }],
        eq(col("status", "users"), param(1, "active")),
      )
      .build()

    const r = mssqlPrinter().print(node)
    expect(r.sql).toContain("WHEN NOT MATCHED BY SOURCE AND")
    // MSSQL prints with [brackets]; params are emitted in walk order
    // (condition first, then SET value).
    expect(r.sql).toContain("THEN UPDATE SET [status] = @p1")
    expect(r.params).toEqual(["active", "archived"])
  })
})

// ─── Typed builder surface ────────────────────────────────────────────

const dbForTyped = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      status: text().notNull(),
    },
    staging: {
      id: serial().primaryKey(),
      name: text().notNull(),
      status: text().notNull(),
    },
  },
})

describe("TypedMergeBuilder — WHEN NOT MATCHED BY SOURCE", () => {
  it("whenNotMatchedBySourceThenDelete", () => {
    const q = dbForTyped
      .mergeInto("users", {
        source: "staging",
        alias: "s",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenMatchedThenUpdate({ name: "updated" })
      .whenNotMatchedBySourceThenDelete()
      .toSQL()
    expect(q.sql).toContain("WHEN NOT MATCHED BY SOURCE THEN DELETE")
  })

  it("whenNotMatchedBySourceThenUpdate", () => {
    const q = dbForTyped
      .mergeInto("users", {
        source: "staging",
        alias: "s",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenNotMatchedBySourceThenUpdate({ status: "archived" })
      .toSQL()
    expect(q.sql).toContain('WHEN NOT MATCHED BY SOURCE THEN UPDATE SET "status" = $')
    expect(q.params).toEqual(["archived"])
  })

  it("whenNotMatchedBySourceThenUpdate with condition (proxy)", () => {
    const q = dbForTyped
      .mergeInto("users", {
        source: "staging",
        alias: "s",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenNotMatchedBySourceThenUpdate({ status: "archived" }, ({ target }) =>
        target.status.eq("active"),
      )
      .toSQL()
    expect(q.sql).toContain("WHEN NOT MATCHED BY SOURCE AND")
    expect(q.sql).toContain("THEN UPDATE SET")
    expect(q.params).toContain("archived")
    expect(q.params).toContain("active")
  })

  it("rejects empty update object (would emit invalid SQL)", () => {
    expect(() =>
      dbForTyped
        .mergeInto("users", {
          source: "staging",
          alias: "s",
          on: ({ target, source }) => target.id.eq(source.id),
        })
        .whenNotMatchedBySourceThenUpdate({}),
    ).toThrow(/at least one column/i)
  })
})

// ─── PGlite roundtrip ────────────────────────────────────────────────

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    CREATE TABLE target_t (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE source_t (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
  `)
})

afterAll(async () => {
  await pg.close()
})

const rtDb = sumak({
  dialect: pgDialect(),
  tables: {
    target_t: {
      id: integer().primaryKey(),
      name: text().notNull(),
      status: text().notNull(),
    },
    source_t: {
      id: integer().primaryKey(),
      name: text().notNull(),
    },
  },
})

describe("PGlite roundtrip — full-sync MERGE with all three WHEN branches", () => {
  it("matched UPDATE, not_matched INSERT, not_matched_by_source DELETE", async () => {
    // PGlite needs PG 17+ for `WHEN NOT MATCHED BY SOURCE`. Skip if the
    // bundled version doesn't support it — we'd rather skip than fail
    // the whole suite on an environment we don't control.
    const versionRes = await pg.query<{ server_version: string }>(`SHOW server_version`)
    const major = parseInt(versionRes.rows[0]?.server_version?.split(".")[0] ?? "0", 10)
    if (major < 17) {
      // eslint-disable-next-line no-console
      console.log(`Skipping PGlite roundtrip — server is PG ${major}, need 17+`)
      return
    }

    // Reset tables.
    await pg.exec(`TRUNCATE target_t, source_t;`)
    await pg.exec(`
      INSERT INTO target_t (id, name, status) VALUES
        (1, 'Alice', 'active'),
        (2, 'Bob', 'active'),
        (3, 'Charlie', 'active');
      INSERT INTO source_t (id, name) VALUES
        (1, 'Alice-renamed'),
        (4, 'Dave');
    `)

    const q = rtDb
      .mergeInto("target_t", {
        source: "source_t",
        alias: "s",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenMatchedThenUpdate({ name: "merged" })
      .whenNotMatchedThenInsert({ id: 99, name: "from-not-matched", status: "active" })
      .whenNotMatchedBySourceThenDelete()
      .toSQL()

    await pg.query(q.sql, q.params as any[])

    const { rows } = await pg.query<{ id: number; name: string }>(
      "SELECT id, name FROM target_t ORDER BY id",
    )
    // id=1 matched → name='merged'
    // id=2, id=3 unmatched by source → deleted
    // id=4 from source had no target → INSERT branch fires (but uses id=99
    //   because the source row isn't projected by our hard-coded values;
    //   we just verify the branch fires by counting rows).
    // Result: {1 merged, 99 from-not-matched}.
    expect(rows).toEqual([
      { id: 1, name: "merged" },
      { id: 99, name: "from-not-matched" },
    ])
  })

  it("not_matched_by_source UPDATE with AND condition", async () => {
    const versionRes = await pg.query<{ server_version: string }>(`SHOW server_version`)
    const major = parseInt(versionRes.rows[0]?.server_version?.split(".")[0] ?? "0", 10)
    if (major < 17) {
      // eslint-disable-next-line no-console
      console.log(`Skipping PGlite roundtrip — server is PG ${major}, need 17+`)
      return
    }

    await pg.exec(`TRUNCATE target_t, source_t;`)
    await pg.exec(`
      INSERT INTO target_t (id, name, status) VALUES
        (1, 'Alice', 'active'),
        (2, 'Bob', 'active'),
        (3, 'Charlie', 'inactive');
      INSERT INTO source_t (id, name) VALUES (1, 'Alice-still-here');
    `)

    const q = rtDb
      .mergeInto("target_t", {
        source: "source_t",
        alias: "s",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenNotMatchedBySourceThenUpdate({ status: "archived" }, ({ target }) =>
        target.status.eq("active"),
      )
      .toSQL()

    await pg.query(q.sql, q.params as any[])

    const { rows } = await pg.query<{ id: number; status: string }>(
      "SELECT id, status FROM target_t ORDER BY id",
    )
    // id=1: matched (no MATCHED branch) — unchanged ('active')
    // id=2: not matched by source AND status='active' → 'archived'
    // id=3: not matched by source AND status='inactive' (cond false) → unchanged
    expect(rows).toEqual([
      { id: 1, status: "active" },
      { id: 2, status: "archived" },
      { id: 3, status: "inactive" },
    ])
  })
})
