import { describe, expect, it } from "vitest"

import { generateSchemaCode } from "../../src/introspect/generate.ts"
import type { IntrospectedSchema } from "../../src/introspect/types.ts"

describe("generateSchemaCode", () => {
  it("emits a single-table tables object", () => {
    const schema: IntrospectedSchema = {
      dialect: "pg",
      tables: [
        {
          name: "users",
          columns: [
            {
              name: "id",
              dataType: "serial",
              nullable: false,
              isPrimaryKey: true,
              isUnique: false,
            },
            {
              name: "name",
              dataType: "text",
              nullable: false,
              isPrimaryKey: false,
              isUnique: false,
            },
            {
              name: "email",
              dataType: "text",
              nullable: true,
              isPrimaryKey: false,
              isUnique: true,
            },
          ],
        },
      ],
    }
    const code = generateSchemaCode(schema)
    expect(code).toContain(`import { serial, text } from "sumak/schema"`)
    expect(code).toContain(`id: serial().primaryKey()`)
    expect(code).toContain(`name: text().notNull()`)
    expect(code).toContain(`email: text().unique().nullable()`)
    expect(code).toContain("export const tables")
  })

  it("emits foreign keys as .references(...)", () => {
    const schema: IntrospectedSchema = {
      dialect: "pg",
      tables: [
        {
          name: "posts",
          columns: [
            {
              name: "id",
              dataType: "serial",
              nullable: false,
              isPrimaryKey: true,
              isUnique: false,
            },
            {
              name: "user_id",
              dataType: "integer",
              nullable: false,
              isPrimaryKey: false,
              isUnique: false,
              references: { table: "users", column: "id", onDelete: "CASCADE" },
            },
          ],
        },
      ],
    }
    const code = generateSchemaCode(schema)
    expect(code).toContain(`.references("users", "id")`)
    expect(code).toContain(`.onDelete("CASCADE")`)
  })

  it("quotes non-identifier column names", () => {
    const schema: IntrospectedSchema = {
      dialect: "pg",
      tables: [
        {
          name: "foo",
          columns: [
            {
              name: "has-hyphen",
              dataType: "text",
              nullable: false,
              isPrimaryKey: false,
              isUnique: false,
            },
          ],
        },
      ],
    }
    const code = generateSchemaCode(schema)
    expect(code).toContain(`"has-hyphen": text().notNull()`)
  })

  it("supports custom varName + no-import mode", () => {
    const schema: IntrospectedSchema = {
      dialect: "pg",
      tables: [
        {
          name: "t",
          columns: [
            {
              name: "id",
              dataType: "serial",
              nullable: false,
              isPrimaryKey: true,
              isUnique: false,
            },
          ],
        },
      ],
    }
    const code = generateSchemaCode(schema, {
      varName: "mySchema",
      includeImport: false,
    })
    expect(code).not.toContain("import")
    expect(code).toContain("export const mySchema")
  })

  it("produces lexicographically sorted factory imports", () => {
    const schema: IntrospectedSchema = {
      dialect: "pg",
      tables: [
        {
          name: "t",
          columns: [
            {
              name: "a",
              dataType: "text",
              nullable: false,
              isPrimaryKey: false,
              isUnique: false,
            },
            {
              name: "b",
              dataType: "serial",
              nullable: false,
              isPrimaryKey: true,
              isUnique: false,
            },
            {
              name: "c",
              dataType: "integer",
              nullable: true,
              isPrimaryKey: false,
              isUnique: false,
            },
          ],
        },
      ],
    }
    const code = generateSchemaCode(schema)
    const imports = code.match(/import \{ ([^}]+) \}/)![1]!
    const names = imports.split(",").map((s) => s.trim())
    const sorted = [...names].sort()
    expect(names).toEqual(sorted)
  })
})
