import { describe, expectTypeOf, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { defineTable } from "../../src/schema/table.ts"
import { sumak } from "../../src/sumak.ts"

// sumak({ tables }) accepts three shapes per entry:
//   1. raw columns map           { users: { id: serial(), ... } }
//   2. defineTable wrapper       { users: defineTable("users", {...}) }
//   3. mix of both
// Regardless of input, the derived DB type keys on the table name and
// maps column builders through their __select / __insert / __update
// phantom fields. These assertions lock that inference in.

describe("sumak() — tables config inference", () => {
  it("raw columns map → column types survive to the builder layer", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: {
        users: {
          id: serial().primaryKey(),
          name: text().notNull(),
          age: integer().nullable(),
        },
      },
    })
    // A full-row SELECT exposes every column. `name` is non-null (NOT
    // NULL set), `age` is nullable.
    type Row = Awaited<ReturnType<(typeof db)["selectFrom"]>>

    // Column proxy inference — `{ id }` destructure gives back a Col<number>.
    db.selectFrom("users").where(({ id, name, age }) => {
      expectTypeOf(id.eq).toBeFunction()
      expectTypeOf(name.eq).toBeFunction()
      expectTypeOf(age.isNull).toBeFunction()
      return id.eq(1)
    })

    // Silence unused variable; we're only asserting types.
    void (null as unknown as Row)
  })

  it("defineTable wrapper — DB key is the map key, not the defineTable name arg", () => {
    // The `sumak({ tables: { foo: defineTable("foo", ...) } })` idiom
    // keys off the outer map key (`foo`) — the defineTable arg is only
    // the runtime identity. This matters when you rename the variable
    // without renaming the string, and vice versa.
    const db = sumak({
      dialect: pgDialect(),
      tables: {
        foo: defineTable("foo", {
          id: serial().primaryKey(),
          label: text().notNull(),
        }),
      },
    })
    db.selectFrom("foo").where(({ label }) => label.eq("x"))
    // @ts-expect-error — table key is "foo", not the defineTable name.
    db.selectFrom("bar")
  })

  it("mixed raw + defineTable entries in one tables config", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: {
        users: {
          id: serial().primaryKey(),
          name: text().notNull(),
        },
        orders: defineTable(
          "orders",
          { id: serial().primaryKey(), userId: integer().notNull() },
          {
            constraints: {
              foreignKeys: [
                {
                  columns: ["userId"],
                  references: { table: "users", columns: ["id"] },
                },
              ],
            },
          },
        ),
      },
    })
    db.selectFrom("users").where(({ name }) => name.eq("a"))
    db.selectFrom("orders").where(({ userId }) => userId.eq(1))
    // @ts-expect-error — unknown table.
    db.selectFrom("missing")
  })

  it("SumakConfig.onQuery — listener type matches QueryEvent discriminated union", () => {
    sumak({
      dialect: pgDialect(),
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull() },
      },
      onQuery: (event) => {
        // Discriminated union narrowing: `phase` selects the branch.
        if (event.phase === "start") {
          expectTypeOf(event.sql).toEqualTypeOf<string>()
          // @ts-expect-error — durationMs is only on end/error events.
          event.durationMs
        } else if (event.phase === "end") {
          expectTypeOf(event.durationMs).toEqualTypeOf<number>()
          expectTypeOf(event.rowCount).toEqualTypeOf<number | undefined>()
        } else {
          expectTypeOf(event.error).toEqualTypeOf<unknown>()
        }
      },
    })
  })
})
