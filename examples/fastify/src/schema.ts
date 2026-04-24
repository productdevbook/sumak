import { integer, serial, text, timestamp } from "sumak/schema"

export const tables = {
  products: {
    id: serial().primaryKey(),
    sku: text().notNull().unique(),
    name: text().notNull(),
    priceCents: integer().notNull().check("price_cents > 0"),
    createdAt: timestamp().notNull().defaultTo("now()"),
  },
} as const
