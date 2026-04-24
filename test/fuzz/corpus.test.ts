import { describe, expect, it } from "vitest"

import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import type { Dialect } from "../../src/dialect/types.ts"
import { SumakError } from "../../src/errors.ts"
import { corpus } from "./corpus.ts"

const DIALECTS: readonly { name: string; dialect: Dialect }[] = [
  { name: "pg", dialect: pgDialect() },
  { name: "mysql", dialect: mysqlDialect() },
  { name: "sqlite", dialect: sqliteDialect() },
  { name: "mssql", dialect: mssqlDialect() },
]

// Every corpus entry is a regression guard. Print each shape against
// every dialect; the only acceptable outcomes are (1) clean string
// output, or (2) a SumakError subclass (the dialect deliberately
// rejected an unsupported combination). Any other throw is a bug.

describe("regression corpus — AST shapes that once crashed the printer", () => {
  for (const entry of corpus) {
    describe(entry.name, () => {
      for (const { name, dialect } of DIALECTS) {
        it(`prints on ${name} without crashing`, () => {
          try {
            const sql = dialect.createPrinter().print(entry.node).sql
            expect(typeof sql).toBe("string")
            expect(sql.length).toBeGreaterThan(0)
          } catch (err) {
            if (err instanceof SumakError) {
              // Legitimate — dialect refused an unsupported shape.
              return
            }
            throw err
          }
        })
      }
    })
  }
})
