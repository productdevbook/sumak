import { integer, serial, text, timestamp } from "sumak/schema"

export const tables = {
  events: {
    id: serial().primaryKey(),
    source: text().notNull(),
    payload: text().notNull(),
    occurredAt: timestamp().notNull().defaultTo("now()"),
    seq: integer().notNull(),
  },
} as const
