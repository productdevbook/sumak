import { describe, expect, it } from "vitest"

import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sumak } from "../../src/sumak.ts"

describe("CREATE TABLE", () => {
  const db = sumak({ dialect: pgDialect(), tables: {} })

  it("basic CREATE TABLE", () => {
    const node = db.schema
      .createTable("users")
      .addColumn("id", "serial", (c) => c.primaryKey())
      .addColumn("name", "varchar(255)", (c) => c.notNull())
      .addColumn("email", "varchar", (c) => c.unique().notNull())
      .build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("CREATE TABLE")
    expect(q.sql).toContain('"users"')
    expect(q.sql).toContain("PRIMARY KEY")
    expect(q.sql).toContain("NOT NULL")
    expect(q.sql).toContain("UNIQUE")
  })

  it("IF NOT EXISTS", () => {
    const node = db.schema.createTable("users").ifNotExists().addColumn("id", "serial").build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("IF NOT EXISTS")
  })

  it("TEMPORARY table", () => {
    const node = db.schema.createTable("temp").temporary().addColumn("id", "integer").build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("TEMPORARY")
  })

  it("DEFAULT value", () => {
    const node = db.schema
      .createTable("users")
      .addColumn("active", "boolean", (c) => c.defaultTo({ type: "literal", value: true }))
      .build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("DEFAULT TRUE")
  })

  it("REFERENCES with ON DELETE CASCADE", () => {
    const node = db.schema
      .createTable("posts")
      .addColumn("user_id", "integer", (c) => c.references("users", "id").onDelete("CASCADE"))
      .build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("REFERENCES")
    expect(q.sql).toContain("ON DELETE CASCADE")
  })

  it("table-level PRIMARY KEY constraint", () => {
    const node = db.schema
      .createTable("order_items")
      .addColumn("order_id", "integer")
      .addColumn("product_id", "integer")
      .addPrimaryKeyConstraint("pk_order_items", ["order_id", "product_id"])
      .build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("CONSTRAINT")
    expect(q.sql).toContain("PRIMARY KEY")
  })

  it("UNIQUE constraint", () => {
    const node = db.schema
      .createTable("users")
      .addColumn("email", "varchar")
      .addUniqueConstraint("uq_email", ["email"])
      .build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("UNIQUE")
  })

  it("FOREIGN KEY constraint", () => {
    const node = db.schema
      .createTable("posts")
      .addColumn("user_id", "integer")
      .addForeignKeyConstraint("fk_user", ["user_id"], "users", ["id"], (fk) =>
        fk.onDelete("CASCADE").onUpdate("NO ACTION"),
      )
      .build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("FOREIGN KEY")
    expect(q.sql).toContain("REFERENCES")
    expect(q.sql).toContain("ON DELETE CASCADE")
    expect(q.sql).toContain("ON UPDATE NO ACTION")
  })

  it("MySQL dialect", () => {
    const mydb = sumak({ dialect: mysqlDialect(), tables: {} })
    const node = mydb.schema
      .createTable("users")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .build()
    const q = mydb.compileDDL(node)
    expect(q.sql).toContain("AUTO_INCREMENT")
  })
})

describe("ALTER TABLE", () => {
  const db = sumak({ dialect: pgDialect(), tables: {} })

  it("ADD COLUMN", () => {
    const node = db.schema
      .alterTable("users")
      .addColumn("age", "integer", (c) => c.notNull())
      .build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("ALTER TABLE")
    expect(q.sql).toContain("ADD COLUMN")
    expect(q.sql).toContain("NOT NULL")
  })

  it("DROP COLUMN", () => {
    const node = db.schema.alterTable("users").dropColumn("age").build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("DROP COLUMN")
  })

  it("RENAME COLUMN", () => {
    const node = db.schema.alterTable("users").renameColumn("name", "full_name").build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("RENAME COLUMN")
  })

  it("RENAME TABLE", () => {
    const node = db.schema.alterTable("users").renameTo("people").build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("RENAME TO")
  })

  it("ALTER COLUMN SET NOT NULL", () => {
    const node = db.schema.alterTable("users").alterColumn("name", { type: "set_not_null" }).build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("SET NOT NULL")
  })

  it("ALTER COLUMN DROP DEFAULT", () => {
    const node = db.schema
      .alterTable("users")
      .alterColumn("active", { type: "drop_default" })
      .build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("DROP DEFAULT")
  })

  it("ALTER COLUMN SET DATA TYPE", () => {
    const node = db.schema
      .alterTable("users")
      .alterColumn("age", { type: "set_data_type", dataType: "bigint" })
      .build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("SET DATA TYPE bigint")
  })
})

describe("CREATE INDEX", () => {
  const db = sumak({ dialect: pgDialect(), tables: {} })

  it("basic index", () => {
    const node = db.schema.createIndex("idx_users_name").on("users").column("name").build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("CREATE INDEX")
    expect(q.sql).toContain('"idx_users_name"')
    expect(q.sql).toContain("ON")
    expect(q.sql).toContain('"name"')
  })

  it("UNIQUE index", () => {
    const node = db.schema.createIndex("uq_email").unique().on("users").column("email").build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("CREATE UNIQUE INDEX")
  })

  it("IF NOT EXISTS", () => {
    const node = db.schema.createIndex("idx_test").ifNotExists().on("users").column("name").build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("IF NOT EXISTS")
  })

  it("USING method", () => {
    const node = db.schema.createIndex("idx_tags").on("posts").column("tags").using("gin").build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("USING gin")
  })

  it("multi-column index with direction", () => {
    const node = db.schema
      .createIndex("idx_multi")
      .on("users")
      .column("last_name", "ASC")
      .column("first_name", "DESC")
      .build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("ASC")
    expect(q.sql).toContain("DESC")
  })

  it("partial index with WHERE", () => {
    const node = db.schema
      .createIndex("idx_active")
      .on("users")
      .column("email")
      .where({ type: "raw", sql: "active = true", params: [] })
      .build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("WHERE active = true")
  })
})

describe("DROP operations", () => {
  const db = sumak({ dialect: pgDialect(), tables: {} })

  it("DROP TABLE", () => {
    const q = db.compileDDL(db.schema.dropTable("users").build())
    expect(q.sql).toBe('DROP TABLE "users"')
  })

  it("DROP TABLE IF EXISTS CASCADE", () => {
    const q = db.compileDDL(db.schema.dropTable("users").ifExists().cascade().build())
    expect(q.sql).toContain("IF EXISTS")
    expect(q.sql).toContain("CASCADE")
  })

  it("DROP INDEX", () => {
    const q = db.compileDDL(db.schema.dropIndex("idx_name").build())
    expect(q.sql).toContain("DROP INDEX")
  })

  it("DROP INDEX IF EXISTS", () => {
    const q = db.compileDDL(db.schema.dropIndex("idx_name").ifExists().build())
    expect(q.sql).toContain("IF EXISTS")
  })

  it("DROP VIEW", () => {
    const q = db.compileDDL(db.schema.dropView("my_view").build())
    expect(q.sql).toContain("DROP VIEW")
  })

  it("DROP MATERIALIZED VIEW", () => {
    const q = db.compileDDL(db.schema.dropView("my_view").materialized().ifExists().build())
    expect(q.sql).toContain("DROP MATERIALIZED VIEW")
    expect(q.sql).toContain("IF EXISTS")
  })
})

describe("CREATE VIEW", () => {
  const db = sumak({ dialect: pgDialect(), tables: {} })

  it("basic view", () => {
    const node = db.schema.createView("active_users").build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("CREATE VIEW")
    expect(q.sql).toContain('"active_users"')
  })

  it("OR REPLACE", () => {
    const node = db.schema.createView("my_view").orReplace().build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("OR REPLACE")
  })

  it("MATERIALIZED", () => {
    const node = db.schema.createView("stats").materialized().build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("MATERIALIZED VIEW")
  })

  it("with column list", () => {
    const node = db.schema.createView("my_view").columns("id", "name").build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain('("id", "name")')
  })
})
