import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { typedCol } from "../../src/ast/typed-expression.ts"
import { ltrim, overlay, position, replace, reverse, rtrim, val } from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "./pglite-driver.ts"

// Real-PG evidence that the string-manipulation builders compile through
// the sumak printer and that PG evaluates them with the semantics we
// documented. Mirrors the regex/datetime integration suites.

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    DROP TABLE IF EXISTS sm_rows CASCADE;
    CREATE TABLE sm_rows (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL
    );
    INSERT INTO sm_rows (title, body, email, phone) VALUES
      ('hello',  'foo-bar-baz', 'a@example.com',  '5551234567'),
      ('  spaces  ', 'a b c',  'no-at-sign',     '5559876543'),
      ('000abc', 'foo bar',    'd.user@sub.org', '5550000000');
  `)
})

afterAll(async () => {
  await pg?.close()
})

const schema = {
  sm_rows: {
    id: serial().primaryKey(),
    title: text().notNull(),
    body: text().notNull(),
    email: text().notNull(),
    phone: text().notNull(),
  },
}

const body = typedCol<string>("body")
const email = typedCol<string>("email")
const phone = typedCol<string>("phone")
const title = typedCol<string>("title")

describe("string-manipulation builders roundtrip via PGlite", () => {
  it("REPLACE swaps every occurrence of the needle", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("sm_rows")
      .select({ cleaned: replace(body, val("-"), val(":")) as never })
      .orderBy("id")
      .many()
    expect(rows.map((r) => r.cleaned)).toEqual([
      "foo:bar:baz", // every "-" replaced
      "a b c",
      "foo bar",
    ])
  })

  it("POSITION returns 1-based index or 0", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("sm_rows")
      .select({ at: position(val("@"), email) as never })
      .orderBy("id")
      .many()
    expect(rows.map((r) => r.at)).toEqual([2, 0, 7])
  })

  it("OVERLAY masks a fixed-width slice", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("sm_rows")
      .select({ masked: overlay(phone, val("***"), 4, 3) as never })
      .orderBy("id")
      .many()
    // Phones: 5551234567, 5559876543, 5550000000
    // OVERLAY phone PLACING '***' FROM 4 FOR 3 → digits[1..3] + '***' + digits[7..]
    // i.e. position 1..3 kept, 4..6 replaced (3 chars), 7..end kept.
    expect(rows.map((r) => r.masked)).toEqual(["555***4567", "555***6543", "555***0000"])
  })

  it("OVERLAY without FOR replaces only as many chars as the replacement length", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("sm_rows")
      .select({ x: overlay(phone, val("X"), 1) as never })
      .orderBy("id")
      .limit(1)
      .many()
    // Omitting FOR defaults to the length of the replacement (1 char on PG).
    expect(rows[0].x).toBe("X551234567")
  })

  it("LTRIM / RTRIM strip whitespace with default arg", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("sm_rows")
      .select({
        l: ltrim(title) as never,
        r: rtrim(title) as never,
        both: ltrim(rtrim(title)) as never,
      })
      .where(({ id }) => id.eq(2))
      .many()
    expect(rows[0].l).toBe("spaces  ")
    expect(rows[0].r).toBe("  spaces")
    expect(rows[0].both).toBe("spaces")
  })

  it("LTRIM with chars set strips leading zeros", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("sm_rows")
      .select({ x: ltrim(title, val("0")) as never })
      .where(({ id }) => id.eq(3))
      .many()
    expect(rows[0].x).toBe("abc")
  })

  it("REVERSE flips character order", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("sm_rows")
      .select({ flipped: reverse(title) as never })
      .where(({ id }) => id.eq(1))
      .many()
    expect(rows[0].flipped).toBe("olleh")
  })
})
