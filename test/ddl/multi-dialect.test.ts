import { describe, expect, it } from "vitest"

import { AlterTableBuilder } from "../../src/builder/ddl/alter-table.ts"
import { CreateIndexBuilder } from "../../src/builder/ddl/create-index.ts"
import { CreateTableBuilder } from "../../src/builder/ddl/create-table.ts"
import { DropTableBuilder } from "../../src/builder/ddl/drop.ts"
import { DDLPrinter } from "../../src/printer/ddl.ts"
import type { SQLDialect } from "../../src/types.ts"

function compile(dialect: SQLDialect, node: any) {
  return new DDLPrinter(dialect).print(node)
}

describe("CREATE TABLE — multi-dialect identifier quoting", () => {
  const table = new CreateTableBuilder("users")
    .addColumn("id", "serial", (c) => c.primaryKey())
    .addColumn("name", "varchar(255)", (c) => c.notNull())
    .build()

  it("PG uses double quotes", () => {
    const q = compile("pg", table)
    expect(q.sql).toContain('"users"')
    expect(q.sql).toContain('"id"')
    expect(q.sql).toContain('"name"')
  })

  it("MySQL uses backticks", () => {
    const q = compile("mysql", table)
    expect(q.sql).toContain("`users`")
    expect(q.sql).toContain("`id`")
    expect(q.sql).toContain("`name`")
  })

  it("SQLite uses double quotes", () => {
    const q = compile("sqlite", table)
    expect(q.sql).toContain('"users"')
  })

  it("MSSQL uses square brackets", () => {
    const q = compile("mssql", table)
    expect(q.sql).toContain("[users]")
    expect(q.sql).toContain("[id]")
    expect(q.sql).toContain("[name]")
  })
})

describe("CREATE INDEX — multi-dialect", () => {
  const idx = new CreateIndexBuilder("idx_name").unique().on("users").column("email").build()

  it("PG", () => {
    const q = compile("pg", idx)
    expect(q.sql).toContain('CREATE UNIQUE INDEX "idx_name" ON "users" ("email")')
  })

  it("MySQL", () => {
    const q = compile("mysql", idx)
    expect(q.sql).toContain("CREATE UNIQUE INDEX `idx_name` ON `users` (`email`)")
  })

  it("MSSQL", () => {
    const q = compile("mssql", idx)
    expect(q.sql).toContain("CREATE UNIQUE INDEX [idx_name] ON [users] ([email])")
  })
})

describe("DROP TABLE — multi-dialect", () => {
  it("PG with IF EXISTS CASCADE", () => {
    const node = new DropTableBuilder("users").ifExists().cascade().build()
    const q = compile("pg", node)
    expect(q.sql).toBe('DROP TABLE IF EXISTS "users" CASCADE')
  })

  it("MySQL with IF EXISTS", () => {
    const node = new DropTableBuilder("users").ifExists().build()
    const q = compile("mysql", node)
    expect(q.sql).toBe("DROP TABLE IF EXISTS `users`")
  })

  it("MSSQL", () => {
    const node = new DropTableBuilder("users").build()
    const q = compile("mssql", node)
    expect(q.sql).toBe("DROP TABLE [users]")
  })
})

describe("ALTER TABLE — multi-dialect", () => {
  it("PG ADD COLUMN", () => {
    const node = new AlterTableBuilder("users")
      .addColumn("age", "integer", (c) => c.notNull())
      .build()
    const q = compile("pg", node)
    expect(q.sql).toContain('ALTER TABLE "users" ADD COLUMN "age" integer NOT NULL')
  })

  it("MySQL ADD COLUMN", () => {
    const node = new AlterTableBuilder("users")
      .addColumn("age", "integer", (c) => c.notNull())
      .build()
    const q = compile("mysql", node)
    expect(q.sql).toContain("ALTER TABLE `users` ADD COLUMN `age` integer NOT NULL")
  })

  it("PG RENAME COLUMN", () => {
    const node = new AlterTableBuilder("users").renameColumn("name", "full_name").build()
    const q = compile("pg", node)
    expect(q.sql).toContain("RENAME COLUMN")
    expect(q.sql).toContain('"name"')
    expect(q.sql).toContain('"full_name"')
  })

  it("MSSQL DROP COLUMN", () => {
    const node = new AlterTableBuilder("users").dropColumn("age").build()
    const q = compile("mssql", node)
    expect(q.sql).toContain("[users]")
    expect(q.sql).toContain("DROP COLUMN [age]")
  })
})

describe("CREATE TABLE with constraints — multi-dialect", () => {
  it("PG FOREIGN KEY with ON DELETE CASCADE", () => {
    const node = new CreateTableBuilder("posts")
      .addColumn("id", "serial", (c) => c.primaryKey())
      .addColumn("user_id", "integer", (c) =>
        c.notNull().references("users", "id").onDelete("CASCADE"),
      )
      .build()
    const q = compile("pg", node)
    expect(q.sql).toContain("REFERENCES")
    expect(q.sql).toContain("ON DELETE CASCADE")
  })

  it("MySQL FOREIGN KEY", () => {
    const node = new CreateTableBuilder("posts")
      .addColumn("user_id", "integer", (c) => c.references("users", "id"))
      .build()
    const q = compile("mysql", node)
    expect(q.sql).toContain("REFERENCES `users`(`id`)")
  })

  it("UNIQUE constraint", () => {
    const node = new CreateTableBuilder("users")
      .addColumn("email", "varchar(255)", (c) => c.unique())
      .build()
    const q = compile("pg", node)
    expect(q.sql).toContain("UNIQUE")
  })

  it("CHECK constraint (table-level)", () => {
    const node = new CreateTableBuilder("users")
      .addColumn("age", "integer")
      .addCheckConstraint("ck_age", { type: "raw", sql: "age >= 0", params: [] })
      .build()
    const q = compile("pg", node)
    expect(q.sql).toContain("CHECK (age >= 0)")
  })
})
