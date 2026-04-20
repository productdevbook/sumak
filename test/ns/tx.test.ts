import { describe, expect, it } from "vitest"

import { mssqlDialect, mysqlDialect, pgDialect, sqliteDialect, sumak, tx } from "../../src/index.ts"

function makeDb(d: ReturnType<typeof pgDialect>) {
  return sumak({ dialect: d, tables: { _unused: {} as any } })
}

describe("tx namespace — PostgreSQL", () => {
  const db = makeDb(pgDialect())

  it("begin() produces BEGIN", () => {
    expect(db.compile(tx.begin()).sql).toBe("BEGIN")
  })

  it("begin({ isolation, readOnly }) inlines options in PG", () => {
    expect(db.compile(tx.begin({ isolation: "SERIALIZABLE", readOnly: true })).sql).toBe(
      "BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY",
    )
  })

  it("begin({ isolation: 'SERIALIZABLE', readOnly: true, deferrable: true })", () => {
    expect(
      db.compile(tx.begin({ isolation: "SERIALIZABLE", readOnly: true, deferrable: true })).sql,
    ).toBe("BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE")
  })

  it("commit() / rollback()", () => {
    expect(db.compile(tx.commit()).sql).toBe("COMMIT")
    expect(db.compile(tx.rollback()).sql).toBe("ROLLBACK")
  })

  it("commit({ chain: true }) → COMMIT AND CHAIN", () => {
    expect(db.compile(tx.commit({ chain: true })).sql).toBe("COMMIT AND CHAIN")
    expect(db.compile(tx.rollback({ chain: true })).sql).toBe("ROLLBACK AND CHAIN")
  })

  it("savepoint / rollbackTo / releaseSavepoint", () => {
    expect(db.compile(tx.savepoint("sp1")).sql).toBe('SAVEPOINT "sp1"')
    expect(db.compile(tx.rollbackTo("sp1")).sql).toBe('ROLLBACK TO SAVEPOINT "sp1"')
    expect(db.compile(tx.releaseSavepoint("sp1")).sql).toBe('RELEASE SAVEPOINT "sp1"')
  })

  it("setTransaction({ isolation })", () => {
    expect(db.compile(tx.setTransaction({ isolation: "READ COMMITTED" })).sql).toBe(
      "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
    )
  })
})

describe("tx namespace — MySQL", () => {
  const db = makeDb(mysqlDialect())

  it("begin() → START TRANSACTION", () => {
    expect(db.compile(tx.begin()).sql).toBe("START TRANSACTION")
  })

  it("begin({ consistentSnapshot, readOnly }) → START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY", () => {
    expect(db.compile(tx.begin({ consistentSnapshot: true, readOnly: true })).sql).toBe(
      "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY",
    )
  })

  it("savepoint uses backtick identifier", () => {
    expect(db.compile(tx.savepoint("sp1")).sql).toBe("SAVEPOINT `sp1`")
  })
})

describe("tx namespace — SQLite", () => {
  const db = makeDb(sqliteDialect())

  it("begin() → BEGIN", () => {
    expect(db.compile(tx.begin()).sql).toBe("BEGIN")
  })

  it("begin({ locking: 'IMMEDIATE' }) → BEGIN IMMEDIATE", () => {
    expect(db.compile(tx.begin({ locking: "IMMEDIATE" })).sql).toBe("BEGIN IMMEDIATE")
    expect(db.compile(tx.begin({ locking: "EXCLUSIVE" })).sql).toBe("BEGIN EXCLUSIVE")
    expect(db.compile(tx.begin({ locking: "DEFERRED" })).sql).toBe("BEGIN DEFERRED")
  })
})

describe("tx namespace — MSSQL", () => {
  const db = makeDb(mssqlDialect())

  it("begin() → BEGIN TRANSACTION", () => {
    expect(db.compile(tx.begin()).sql).toBe("BEGIN TRANSACTION")
  })

  it("commit/rollback → COMMIT/ROLLBACK TRANSACTION", () => {
    expect(db.compile(tx.commit()).sql).toBe("COMMIT TRANSACTION")
    expect(db.compile(tx.rollback()).sql).toBe("ROLLBACK TRANSACTION")
  })

  it("savepoint → SAVE TRANSACTION", () => {
    expect(db.compile(tx.savepoint("sp1")).sql).toBe("SAVE TRANSACTION [sp1]")
  })

  it("releaseSavepoint throws on MSSQL", () => {
    expect(() => db.compile(tx.releaseSavepoint("sp1"))).toThrow(/RELEASE SAVEPOINT/)
  })

  it("rollbackTo uses ROLLBACK TRANSACTION form", () => {
    expect(db.compile(tx.rollbackTo("sp1")).sql).toBe("ROLLBACK TRANSACTION [sp1]")
  })

  it("setTransaction supports SNAPSHOT isolation", () => {
    expect(db.compile(tx.setTransaction({ isolation: "SNAPSHOT" })).sql).toBe(
      "SET TRANSACTION ISOLATION LEVEL SNAPSHOT",
    )
  })
})
