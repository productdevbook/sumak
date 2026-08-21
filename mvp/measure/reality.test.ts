import { writeFileSync } from "node:fs"

import { PGlite } from "@electric-sql/pglite"
import { it } from "vitest"

import { int, t, text } from "../index.ts"
import { make } from "../sql.ts"

const q = make({ users: { id: int(), name: text(), email: text() } })

async function timeAsync(fn: () => Promise<unknown>, iters: number): Promise<number> {
  for (let i = 0; i < Math.min(200, iters); i++) await fn()
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < iters; i++) await fn()
  return Number(process.hrtime.bigint() - t0) / iters
}

it("where a real request actually spends its time", async () => {
  const pg = new PGlite()
  await pg.exec(`CREATE TABLE users (id int primary key, name text, email text);`)
  const rows = Array.from({ length: 1000 }, (_, i) => `(${i}, 'user-${i}', 'u${i}@x.io')`)
  await pg.exec(`INSERT INTO users VALUES ${rows.join(",")};`)

  const one = q("SELECT id, name FROM users WHERE id = $1", t.num)
  const many = q("SELECT id, name, email FROM users WHERE id < $1", t.num)

  const tOne = await timeAsync(() => pg.query(one.sql, [...one.bind([7])]), 2000)
  const tHundred = await timeAsync(() => pg.query(many.sql, [...many.bind([100])]), 500)
  const tThousand = await timeAsync(() => pg.query(many.sql, [...many.bind([1000])]), 200)

  const snake = (await pg.query(many.sql, [...many.bind([100])])).rows as Record<string, unknown>[]
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < 20_000; i++) {
    const out = Array.from({ length: snake.length })
    for (let r = 0; r < snake.length; r++) {
      const row = snake[r] as Record<string, unknown>
      out[r] = { id: row.id, name: row.name, email: row.email }
    }
    if (out.length < 0) throw new Error("x")
  }
  const tMap = Number(process.hrtime.bigint() - t0) / 20_000

  const lines = [
    "gercek bir istek, pglite (ayni surecte calisan postgres — ag yok):",
    `  1 satir donen sorgu       : ${(tOne / 1000).toFixed(1)}us`,
    `  100 satir donen sorgu     : ${(tHundred / 1000).toFixed(1)}us`,
    `  1000 satir donen sorgu    : ${(tThousand / 1000).toFixed(1)}us`,
    "",
    `  100 satiri yeniden sekillendirmek (plugin/camelCase isi): ${(tMap / 1000).toFixed(1)}us`,
    "",
    "karsilastirma icin, sorguyu derlemek:",
    `  mvp     : ~0ns`,
    `  sumak   : ~3138ns  (${((3138 / tOne) * 100).toFixed(1)}% — 1 satirlik sorgunun)`,
    `  kysely  : ~3625ns  (${((3625 / tOne) * 100).toFixed(1)}%)`,
    `  drizzle : ~19751ns (${((19751 / tOne) * 100).toFixed(1)}%)`,
  ]
  writeFileSync("mvp/measure/REALITY.txt", `${lines.join("\n")}\n`)
}, 600_000)
