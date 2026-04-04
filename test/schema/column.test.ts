import { describe, expect, it } from "vitest"

import {
  bigint,
  bigserial,
  boolean,
  bytea,
  char,
  date,
  doublePrecision,
  enumType,
  integer,
  json,
  jsonb,
  numeric,
  real,
  serial,
  smallint,
  text,
  time,
  timestamp,
  timestamptz,
  uuid,
  varchar,
} from "../../src/schema/column.ts"

describe("Column builders", () => {
  it("integer creates integer column", () => {
    const col = integer()
    expect(col._def.dataType).toBe("integer")
    expect(col._def.isNotNull).toBe(false)
  })

  it("text creates text column", () => {
    const col = text()
    expect(col._def.dataType).toBe("text")
  })

  it("boolean creates boolean column", () => {
    const col = boolean()
    expect(col._def.dataType).toBe("boolean")
  })

  it("serial creates auto-increment column", () => {
    const col = serial()
    expect(col._def.dataType).toBe("serial")
    expect(col._def.hasDefault).toBe(true)
    expect(col._def.isNotNull).toBe(true)
    expect(col._def.isPrimaryKey).toBe(true)
  })

  it("varchar with length", () => {
    const col = varchar(255)
    expect(col._def.dataType).toBe("varchar(255)")
  })

  it("varchar without length", () => {
    const col = varchar()
    expect(col._def.dataType).toBe("varchar")
  })

  it("char with length", () => {
    const col = char(10)
    expect(col._def.dataType).toBe("char(10)")
  })

  it("numeric with precision and scale", () => {
    const col = numeric(10, 2)
    expect(col._def.dataType).toBe("numeric(10,2)")
  })

  it("numeric with precision only", () => {
    const col = numeric(10)
    expect(col._def.dataType).toBe("numeric(10)")
  })

  it("numeric without args", () => {
    const col = numeric()
    expect(col._def.dataType).toBe("numeric")
  })

  it("timestamp creates timestamp column", () => {
    expect(timestamp()._def.dataType).toBe("timestamp")
  })

  it("timestamptz creates timestamptz column", () => {
    expect(timestamptz()._def.dataType).toBe("timestamptz")
  })

  it("date creates date column", () => {
    expect(date()._def.dataType).toBe("date")
  })

  it("time creates time column", () => {
    expect(time()._def.dataType).toBe("time")
  })

  it("uuid creates uuid column", () => {
    expect(uuid()._def.dataType).toBe("uuid")
  })

  it("json creates json column", () => {
    expect(json()._def.dataType).toBe("json")
  })

  it("jsonb creates jsonb column", () => {
    expect(jsonb()._def.dataType).toBe("jsonb")
  })

  it("bigint creates bigint column", () => {
    expect(bigint()._def.dataType).toBe("bigint")
  })

  it("smallint creates smallint column", () => {
    expect(smallint()._def.dataType).toBe("smallint")
  })

  it("bigserial creates bigserial column", () => {
    const col = bigserial()
    expect(col._def.dataType).toBe("bigserial")
    expect(col._def.hasDefault).toBe(true)
  })

  it("real creates real column", () => {
    expect(real()._def.dataType).toBe("real")
  })

  it("doublePrecision creates double precision column", () => {
    expect(doublePrecision()._def.dataType).toBe("double precision")
  })

  it("bytea creates bytea column", () => {
    expect(bytea()._def.dataType).toBe("bytea")
  })

  it("enumType creates enum column", () => {
    const col = enumType("active", "inactive", "banned")
    expect(col._def.dataType).toBe("enum('active','inactive','banned')")
  })
})

describe("Column builder modifiers", () => {
  it("notNull sets isNotNull", () => {
    const col = text().notNull()
    expect(col._def.isNotNull).toBe(true)
  })

  it("nullable sets isNotNull to false", () => {
    const col = text().notNull().nullable()
    expect(col._def.isNotNull).toBe(false)
  })

  it("defaultTo sets hasDefault", () => {
    const col = text().defaultTo("hello")
    expect(col._def.hasDefault).toBe(true)
  })

  it("primaryKey sets isPrimaryKey and isNotNull", () => {
    const col = integer().primaryKey()
    expect(col._def.isPrimaryKey).toBe(true)
    expect(col._def.isNotNull).toBe(true)
  })

  it("references sets foreign key info", () => {
    const col = integer().references("users", "id")
    expect(col._def.references).toEqual({ table: "users", column: "id" })
  })

  it("chaining modifiers returns new instances", () => {
    const base = text()
    const notNull = base.notNull()
    const withDefault = notNull.defaultTo("x")

    expect(base._def.isNotNull).toBe(false)
    expect(notNull._def.isNotNull).toBe(true)
    expect(withDefault._def.hasDefault).toBe(true)
    expect(notNull._def.hasDefault).toBe(false)
  })
})
