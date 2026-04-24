import { integer, serial, text, timestamp } from "sumak/schema"

export const tables = {
  tasks: {
    id: serial().primaryKey(),
    tenantId: integer().notNull(),
    title: text().notNull(),
    doneAt: timestamp().nullable(),
    createdAt: timestamp().notNull().defaultTo("now()"),
  },
} as const
