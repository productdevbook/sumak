import { writeFileSync } from "node:fs"

import { PGlite } from "@electric-sql/pglite"
import { it } from "vitest"

async function timeAsync(fn: (i: number) => Promise<unknown>, iters: number): Promise<number> {
  for (let i = 0; i < 200; i++) await fn(i)
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < iters; i++) await fn(i)
  return Number(process.hrtime.bigint() - t0) / iters
}

it("what stable sql text buys on the server side", async () => {
  const pg = new PGlite()
  await pg.exec(`CREATE TABLE users (id int primary key, name text, email text);`)
  const rows = Array.from({ length: 1000 }, (_, i) => `(${i}, 'user-${i}', 'u${i}@x.io')`)
  await pg.exec(`INSERT INTO users VALUES ${rows.join(",")};`)
  await pg.exec(`CREATE INDEX ON users (name);`)

  const stable = "SELECT id, name FROM users WHERE id = $1 AND name <> $2"
  const tStable = await timeAsync((i) => pg.query(stable, [i % 900, "zz"]), 2000)

  const tVarying = await timeAsync(
    (i) => pg.query(`SELECT id, name FROM users WHERE id = ${i % 900} AND name <> 'zz'`),
    2000,
  )

  await pg.exec(`PREPARE fixed (int, text) AS ${stable};`)
  const tPrepared = await timeAsync((i) => pg.query(`EXECUTE fixed(${i % 900}, 'zz')`), 2000)

  const lines = [
    "ayni sorgu, uc farkli sekilde — pglite:",
    `  her cagrida farkli metin (literal gomulu) : ${(tVarying / 1000).toFixed(1)}us`,
    `  sabit metin + parametre, isimsiz          : ${(tStable / 1000).toFixed(1)}us`,
    `  PREPARE edilmis, EXECUTE ile              : ${(tPrepared / 1000).toFixed(1)}us`,
    "",
    `  PREPARE'in kazandirdigi: ${((tVarying - tPrepared) / 1000).toFixed(1)}us  (${(tVarying / tPrepared).toFixed(2)}x)`,
    "",
    "PREPARE ancak sorgu metni sabitse mumkun. sumak'ta ayni cagri yeri param",
    "degerlerine gore farkli metin uretebiliyor, yani bu yol kapali kaliyor.",
  ]
  writeFileSync("mvp/measure/PLANCACHE.txt", `${lines.join("\n")}\n`)
}, 900_000)
