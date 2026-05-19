import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { ListenBuilder, NotifyBuilder, UnlistenBuilder } from "../../src/builder/ddl/pubsub.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { SecurityError, UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { listen, notify, unlisten } from "../../src/index.ts"
import { sumak } from "../../src/sumak.ts"

const pg = sumak({ dialect: pgDialect(), tables: {} })
const my = sumak({ dialect: mysqlDialect(), tables: {} })
const sqlite = sumak({ dialect: sqliteDialect(), tables: {} })
const mssql = sumak({ dialect: mssqlDialect(), tables: {} })

describe("LISTEN — builder shape", () => {
  it("listen(channel) wraps the AST node", () => {
    const node = listen("orders_changed").build()
    expect(node).toEqual({ type: "listen", channel: "orders_changed" })
  })

  it(".channel(name) replaces the channel", () => {
    const node = listen("a").channel("b").build()
    expect(node.channel).toBe("b")
  })

  it("builders are immutable — original retains its channel", () => {
    const a = listen("a")
    const b = a.channel("b")
    expect(a.build().channel).toBe("a")
    expect(b.build().channel).toBe("b")
  })

  it("constructor accepts a pre-built node", () => {
    const direct = new ListenBuilder({ type: "listen", channel: "raw" }).build()
    expect(direct).toEqual({ type: "listen", channel: "raw" })
  })
})

describe("LISTEN — PG emission", () => {
  it("simple LISTEN", () => {
    expect(pg.compileDDL(listen("orders_changed").build()).sql).toBe('LISTEN "orders_changed"')
  })

  it("no params produced", () => {
    expect(pg.compileDDL(listen("c").build()).params).toEqual([])
  })

  it("identifier quoting — mixed case survives", () => {
    expect(pg.compileDDL(listen("CacheInvalidation").build()).sql).toBe(
      'LISTEN "CacheInvalidation"',
    )
  })

  it("via db.schema.listen(...)", () => {
    expect(pg.compileDDL(pg.schema.listen("audit").build()).sql).toBe('LISTEN "audit"')
  })

  it("routed via db.compile()", () => {
    expect(pg.compile(pg.schema.listen("audit").build()).sql).toBe('LISTEN "audit"')
  })

  it("rejects channel names that aren't plain identifiers", () => {
    // Channel names land in the SQL identifier slot — `validateFunctionName`
    // refuses anything outside `[A-Za-z_][A-Za-z0-9_]*`, so a payload like
    // `"x; DROP TABLE users; --"` is shut down before reaching the printer.
    expect(() => pg.compileDDL(listen("bad name").build())).toThrow(SecurityError)
    expect(() => pg.compileDDL(listen("x; DROP TABLE users; --").build())).toThrow(SecurityError)
  })
})

describe("UNLISTEN — builder shape", () => {
  it("unlisten(name) wraps a named channel", () => {
    const node = unlisten("orders_changed").build()
    expect(node).toEqual({ type: "unlisten", channel: "orders_changed" })
  })

  it("unlisten('*') wraps the wildcard form", () => {
    const node = unlisten("*").build()
    expect(node).toEqual({ type: "unlisten", channel: "*" })
  })

  it(".channel(name) replaces the channel", () => {
    const node = unlisten("a").channel("*").build()
    expect(node.channel).toBe("*")
  })

  it("builders are immutable across .channel() chains", () => {
    const a = unlisten("a")
    const b = a.channel("b")
    expect(a.build().channel).toBe("a")
    expect(b.build().channel).toBe("b")
  })

  it("constructor accepts a pre-built node", () => {
    const direct = new UnlistenBuilder({ type: "unlisten", channel: "*" }).build()
    expect(direct.channel).toBe("*")
  })
})

describe("UNLISTEN — PG emission", () => {
  it("named channel", () => {
    expect(pg.compileDDL(unlisten("orders_changed").build()).sql).toBe('UNLISTEN "orders_changed"')
  })

  it("wildcard — emits bare `UNLISTEN *`", () => {
    expect(pg.compileDDL(unlisten("*").build()).sql).toBe("UNLISTEN *")
  })

  it("identifier quoting — mixed case survives", () => {
    expect(pg.compileDDL(unlisten("CacheInvalidation").build()).sql).toBe(
      'UNLISTEN "CacheInvalidation"',
    )
  })

  it("via db.schema.unlisten(...)", () => {
    expect(pg.compileDDL(pg.schema.unlisten("audit").build()).sql).toBe('UNLISTEN "audit"')
  })

  it("via db.schema.unlisten('*')", () => {
    expect(pg.compileDDL(pg.schema.unlisten("*").build()).sql).toBe("UNLISTEN *")
  })

  it("rejects channel names that aren't plain identifiers", () => {
    expect(() => pg.compileDDL(unlisten("bad name").build())).toThrow(SecurityError)
  })

  it("wildcard form skips identifier validation", () => {
    // `*` is treated as the wildcard token, not as a channel identifier,
    // so it bypasses `validateFunctionName` even though it'd fail the
    // regex if checked.
    expect(() => pg.compileDDL(unlisten("*").build())).not.toThrow()
  })
})

describe("NOTIFY — builder shape", () => {
  it("notify(channel) wraps the AST node with no payload", () => {
    const node = notify("orders_changed").build()
    expect(node).toEqual({ type: "notify", channel: "orders_changed" })
    expect(node.payload).toBeUndefined()
  })

  it(".payload(text) sets the slot", () => {
    const node = notify("orders_changed").payload("42").build()
    expect(node.payload).toBe("42")
  })

  it(".payload(undefined) clears a previously-set payload", () => {
    const node = notify("c").payload("set").payload(undefined).build()
    expect(node.payload).toBeUndefined()
  })

  it("builders are immutable across .payload() chains", () => {
    const a = notify("c")
    const b = a.payload("first")
    const c = b.payload("second")
    expect(a.build().payload).toBeUndefined()
    expect(b.build().payload).toBe("first")
    expect(c.build().payload).toBe("second")
  })

  it(".channel(name) replaces the channel", () => {
    const node = notify("a").channel("b").build()
    expect(node.channel).toBe("b")
  })

  it("constructor accepts a pre-built node", () => {
    const direct = new NotifyBuilder({ type: "notify", channel: "raw", payload: "p" }).build()
    expect(direct).toEqual({ type: "notify", channel: "raw", payload: "p" })
  })
})

describe("NOTIFY — PG emission", () => {
  it("no payload — bare statement", () => {
    expect(pg.compileDDL(notify("orders_changed").build()).sql).toBe('NOTIFY "orders_changed"')
  })

  it("with payload — single-quoted literal", () => {
    expect(pg.compileDDL(notify("orders_changed").payload("123").build()).sql).toBe(
      `NOTIFY "orders_changed", '123'`,
    )
  })

  it("payload with single quote — doubled at print time", () => {
    // `O'Brien` becomes `'O''Brien'` after escapeStringLiteral, which is
    // the ANSI-SQL way to encode an embedded single quote.
    expect(pg.compileDDL(notify("audit").payload("O'Brien").build()).sql).toBe(
      `NOTIFY "audit", 'O''Brien'`,
    )
  })

  it("payload with backslash — doubled (MySQL backslash-escape defence)", () => {
    // Backslashes are doubled by escapeStringLiteral to neutralise
    // MySQL's BACKSLASH_ESCAPES sql_mode (irrelevant on PG itself but
    // uniform with every other string-literal slot in the printer).
    expect(pg.compileDDL(notify("audit").payload("C:\\Windows").build()).sql).toBe(
      `NOTIFY "audit", 'C:\\\\Windows'`,
    )
  })

  it("payload with JSON content — survives intact", () => {
    const body = JSON.stringify({ id: 42, op: "delete" })
    expect(pg.compileDDL(notify("audit").payload(body).build()).sql).toBe(
      `NOTIFY "audit", '{"id":42,"op":"delete"}'`,
    )
  })

  it("payload with embedded newline survives", () => {
    expect(pg.compileDDL(notify("audit").payload("line1\nline2").build()).sql).toBe(
      `NOTIFY "audit", 'line1\nline2'`,
    )
  })

  it("empty-string payload — emits the empty SQL literal", () => {
    expect(pg.compileDDL(notify("audit").payload("").build()).sql).toBe(`NOTIFY "audit", ''`)
  })

  it("no params produced even when payload is set", () => {
    expect(pg.compileDDL(notify("c").payload("anything").build()).params).toEqual([])
  })

  it("identifier quoting — mixed case survives", () => {
    expect(pg.compileDDL(notify("CacheInvalidation").build()).sql).toBe(
      'NOTIFY "CacheInvalidation"',
    )
  })

  it("via db.schema.notify(...)", () => {
    expect(pg.compileDDL(pg.schema.notify("audit").payload("x").build()).sql).toBe(
      `NOTIFY "audit", 'x'`,
    )
  })

  it("rejects channel names that aren't plain identifiers", () => {
    expect(() => pg.compileDDL(notify("bad name").build())).toThrow(SecurityError)
    expect(() => pg.compileDDL(notify("x; DROP TABLE users; --").payload("p").build())).toThrow(
      SecurityError,
    )
  })

  it("routed via db.compile()", () => {
    expect(pg.compile(pg.schema.notify("audit").payload("x").build()).sql).toBe(
      `NOTIFY "audit", 'x'`,
    )
  })
})

describe("LISTEN / UNLISTEN / NOTIFY — non-PG refusal", () => {
  const cases = [
    ["LISTEN", listen("c").build()],
    ["UNLISTEN", unlisten("c").build()],
    ["UNLISTEN *", unlisten("*").build()],
    ["NOTIFY", notify("c").build()],
    ["NOTIFY with payload", notify("c").payload("p").build()],
  ] as const

  for (const [label, node] of cases) {
    it(`MySQL refuses ${label}`, () => {
      expect(() => my.compileDDL(node)).toThrow(UnsupportedDialectFeatureError)
    })

    it(`SQLite refuses ${label}`, () => {
      expect(() => sqlite.compileDDL(node)).toThrow(UnsupportedDialectFeatureError)
    })

    it(`MSSQL refuses ${label}`, () => {
      expect(() => mssql.compileDDL(node)).toThrow(UnsupportedDialectFeatureError)
    })
  }

  it("error message names the LISTEN / NOTIFY / UNLISTEN feature", () => {
    try {
      my.compileDDL(listen("c").build())
      throw new Error("unreachable")
    } catch (e) {
      expect((e as Error).message).toMatch(/LISTEN \/ NOTIFY \/ UNLISTEN/)
    }
  })
})

describe("LISTEN / NOTIFY / UNLISTEN — PGlite roundtrip", () => {
  let pgdb: PGlite

  beforeAll(async () => {
    pgdb = new PGlite()
    await pgdb.waitReady
  })

  afterAll(async () => {
    await pgdb?.close()
  })

  it("LISTEN emitted SQL parses on the live engine", async () => {
    // PGlite's high-level `.listen(...)` helper wraps the SQL we emit
    // under the hood; we exercise the raw `LISTEN <channel>` string we
    // produced to prove the grammar is exact.
    const sql = pg.compileDDL(pg.schema.listen("roundtrip_chan").build()).sql
    await pgdb.exec(sql)
    // Cleanup so the subscription doesn't leak between tests.
    await pgdb.exec(pg.compileDDL(pg.schema.unlisten("roundtrip_chan").build()).sql)
  })

  it("NOTIFY emitted SQL parses with and without payload", async () => {
    await pgdb.exec(pg.compileDDL(pg.schema.notify("roundtrip_chan").build()).sql)
    await pgdb.exec(pg.compileDDL(pg.schema.notify("roundtrip_chan").payload("hi").build()).sql)
  })

  it("UNLISTEN * cleans up every subscription", async () => {
    await pgdb.exec(pg.compileDDL(pg.schema.listen("a").build()).sql)
    await pgdb.exec(pg.compileDDL(pg.schema.listen("b").build()).sql)
    await pgdb.exec(pg.compileDDL(pg.schema.unlisten("*").build()).sql)
  })

  it("end-to-end LISTEN → NOTIFY → callback (PGlite high-level API)", async () => {
    // PGlite exposes `pgdb.listen(channel, cb)` which subscribes via PG's
    // LISTEN under the hood and routes payloads back to the callback.
    // We compile our own NOTIFY SQL and exec it; PGlite's listener then
    // surfaces the payload synchronously to the in-process callback.
    const received: string[] = []
    const unsubscribe = await pgdb.listen("e2e_chan", (payload) => {
      received.push(payload)
    })

    const notifySql = pg.compileDDL(pg.schema.notify("e2e_chan").payload("hello").build()).sql
    await pgdb.exec(notifySql)

    // PGlite delivers notifications synchronously after exec() resolves.
    // Give it one event-loop tick so any microtask wiring catches up.
    await new Promise((r) => setTimeout(r, 10))

    expect(received).toEqual(["hello"])
    await unsubscribe()
  })

  it("end-to-end with payload-quote escape (O'Brien)", async () => {
    const received: string[] = []
    const unsubscribe = await pgdb.listen("e2e_quotes", (payload) => {
      received.push(payload)
    })

    const sql = pg.compileDDL(pg.schema.notify("e2e_quotes").payload("O'Brien").build()).sql
    expect(sql).toBe(`NOTIFY "e2e_quotes", 'O''Brien'`)
    await pgdb.exec(sql)

    await new Promise((r) => setTimeout(r, 10))

    // PG decodes the doubled `''` back to a single `'` in the payload it
    // delivers to the listener — i.e. the round-trip is identity.
    expect(received).toEqual(["O'Brien"])
    await unsubscribe()
  })
})
