import { writeFileSync } from "node:fs"

import { it } from "vitest"

import { db, int, t, text, ts } from "../index.ts"
import { make } from "../sql.ts"

const schema = {
  users: { id: int(), name: text(), email: text(), createdAt: ts() },
  posts: { id: int(), authorId: int(), title: text(), body: text(), published: int() },
}

const b = db(schema)
const q = make(schema)

function time(fn: () => unknown, iters = 50_000): number {
  for (let i = 0; i < 5_000; i++) fn()
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < iters; i++) fn()
  return Number(process.hrtime.bigint() - t0) / iters
}

it("startup cost of the two shapes", () => {
  const tBuilder = time(() =>
    b
      .from("users")
      .params(t.num)
      .pick("id", "name")
      .where((c, [id]) => c.users.id.eq(id))
      .build(),
  )
  const tTag = time(() => q("SELECT id, name FROM users WHERE id = $1", t.num))

  const lines = [
    "bir sorguyu hazir hale getirmek (uygulama acilisinda, bir kez):",
    `  builder  : ${tBuilder.toFixed(0)}ns`,
    `  sablon   : ${tTag.toFixed(0)}ns`,
    "",
    "istek basina ikisi de: bir alan okumasi (olcum tabani ~5ns)",
  ]
  writeFileSync("mvp/measure/STARTUP.txt", `${lines.join("\n")}\n`)
}, 300_000)
