import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

// Writing a query and running one are two phases, and a builder that can only
// do the first half leaves its callers on the path that recompiles per request.
// The gap was real: INSERT, UPDATE and DELETE could compile but the RETURNING
// forms could not, MERGE could not at all, and neither could EXPLAIN.
//
// This reads the source rather than the exports, because the hole appears when
// someone adds a builder, not when they add a test.

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (entry.endsWith(".ts")) out.push(path)
  }
  return out
}

interface Builder {
  file: string
  name: string
  compiles: boolean
}

function builders(): Builder[] {
  const found: Builder[] = []
  for (const file of sourceFiles("src/builder")) {
    const source = readFileSync(file, "utf8")
    const classes = [...source.matchAll(/export class (\w+)/g)]
    for (const [index, match] of classes.entries()) {
      const start = match.index
      const end = classes[index + 1]?.index ?? source.length
      const body = source.slice(start, end)
      if (!/\n {2}toSQL\(/.test(body)) continue
      found.push({ file, name: match[1] as string, compiles: /\n {2}toCompiled/.test(body) })
    }
  }
  return found
}

describe("every builder that emits SQL can be compiled", () => {
  it("finds the builders to check", () => {
    const all = builders()
    expect(all.length).toBeGreaterThanOrEqual(10)
    expect(all.map((b) => b.name)).toContain("TypedSelectBuilder")
  })

  it("leaves none of them on the recompile-per-call path", () => {
    const missing = builders()
      .filter((b) => !b.compiles)
      .map((b) => `${b.name} (${b.file})`)

    expect(missing).toEqual([])
  })
})
