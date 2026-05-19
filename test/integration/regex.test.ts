import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { typedCol } from "../../src/ast/typed-expression.ts"
import { regexpLike, regexpMatches, regexpReplace, regexpSubstr } from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "./pglite-driver.ts"

// Real-PG evidence that the regex builders compile through the sumak
// printer and that PG evaluates them with the semantics we documented.

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    DROP TABLE IF EXISTS rx_posts CASCADE;
    CREATE TABLE rx_posts (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      email TEXT NOT NULL
    );
    INSERT INTO rx_posts (title, body, email) VALUES
      ('a', 'phone 555-0100',     'a@example.com'),
      ('b', 'visit https://x.io', 'b+tag@example.com'),
      ('c', 'no digits here',     'invalid-no-at-sign'),
      ('d', '2026-05-19',         'd.user@sub.example.org');
  `)
})

afterAll(async () => {
  await pg?.close()
})

const schema = {
  rx_posts: {
    id: serial().primaryKey(),
    title: text().notNull(),
    body: text().notNull(),
    email: text().notNull(),
  },
}

const body = typedCol<string>("body")
const email = typedCol<string>("email")

describe("regexpReplace roundtrip via PGlite", () => {
  it("REGEXP_REPLACE strips non-digits", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("rx_posts")
      .select({ digits: regexpReplace(body, "[^0-9]", "", "g") as never })
      .orderBy("id")
      .many()
    expect(rows).toHaveLength(4)
    // 'phone 555-0100' -> '5550100' ; 'visit https://x.io' -> '' ;
    // 'no digits here' -> '' ; '2026-05-19' -> '20260519'.
    expect(rows.map((r) => r.digits)).toEqual(["5550100", "", "", "20260519"])
  })

  it("REGEXP_REPLACE without the 'g' flag replaces only the first match", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("rx_posts")
      .select({ once: regexpReplace(body, "[0-9]", "*") as never })
      .where(({ id }) => id.eq(1))
      .many()
    expect(rows).toHaveLength(1)
    // 'phone 555-0100' -> 'phone *55-0100' (only the first digit is replaced).
    expect(rows[0].once).toBe("phone *55-0100")
  })
})

describe("regexpLike roundtrip via PGlite", () => {
  it("REGEXP_LIKE filters rows where the column matches the pattern", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("rx_posts")
      .selectAll()
      // POSIX character classes — no backslashes needed (sumak's
      // literal escape policy doubles backslashes for the MySQL
      // BACKSLASH_ESCAPES sql_mode, so `\d`/`\s` patterns from JS
      // would be passed through as literal `\d`/`\s` and would not
      // match the digit/space classes. Use POSIX `[[:class:]]` and
      // bare character ranges for portability.)
      .where(() => regexpLike(email, "^[^@ ]+@[^@ ]+[.][^@ ]+$"))
      .orderBy("id")
      .many()
    // a@example.com, b+tag@example.com, d.user@sub.example.org match.
    // 'invalid-no-at-sign' does not.
    expect(rows.map((r) => r.id)).toEqual([1, 2, 4])
  })

  it("REGEXP_LIKE with the 'i' flag is case-insensitive", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("rx_posts")
      .selectAll()
      .where(() => regexpLike(body, "PHONE", "i"))
      .many()
    // Only row 1 ('phone …') matches case-insensitively.
    expect(rows.map((r) => r.id)).toEqual([1])
  })
})

describe("regexpMatches roundtrip via PGlite", () => {
  it("REGEXP_MATCHES returns the capture-group array", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("rx_posts")
      .select({
        // Use a literal ` ` (space) in the negated set instead of
        // `\s`: sumak's escape policy passes `\` through as a literal
        // backslash for safety against the MySQL BACKSLASH_ESCAPES
        // mode, so PG-flavoured `\s` would be matched literally.
        host: regexpMatches(body, "https?://([^ ]+)") as never,
      })
      .where(({ id }) => id.eq(2))
      .many()
    expect(rows).toHaveLength(1)
    // PG returns a text[] — accept either the array form or, if the
    // driver surfaces it as a string, an array-looking textual form.
    const host = rows[0].host as unknown
    if (Array.isArray(host)) {
      expect(host).toEqual(["x.io"])
    } else {
      expect(String(host)).toContain("x.io")
    }
  })
})

describe("regexpSubstr roundtrip via PGlite", () => {
  it("REGEXP_SUBSTR returns the first matched substring", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("rx_posts")
      // POSIX `[[:digit:]]` rather than `\d` — see the comment in
      // regexpLike above for why backslash escapes round-trip as
      // literal backslashes through sumak's literal-escape policy.
      .select({ first: regexpSubstr(body, "[[:digit:]]+") as never })
      .orderBy("id")
      .many()
    expect(rows).toHaveLength(4)
    // 'phone 555-0100' -> '555' (first run of digits) ;
    // 'visit https://x.io' -> null ;
    // 'no digits here' -> null ;
    // '2026-05-19' -> '2026'.
    const firsts = rows.map((r) => r.first)
    expect(firsts[0]).toBe("555")
    expect(firsts[1]).toBeNull()
    expect(firsts[2]).toBeNull()
    expect(firsts[3]).toBe("2026")
  })
})
