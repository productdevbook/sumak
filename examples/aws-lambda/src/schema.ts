import { serial, text, timestamp } from "sumak/schema"

export const tables = {
  events: {
    id: serial().primaryKey(),
    userId: text().notNull(),
    kind: text().notNull(),
    payload: text().notNull(),
    at: timestamp().notNull().defaultTo("now()"),
  },
} as const
