import { integer, serial, text, timestamp } from "sumak/schema"

export const tables = {
  users: {
    id: serial().primaryKey(),
    email: text().notNull().unique(),
    name: text().notNull(),
    createdAt: timestamp().notNull().defaultTo("now()"),
  },
  posts: {
    id: serial().primaryKey(),
    authorId: integer().notNull().references("users", "id"),
    title: text().notNull(),
    body: text().notNull(),
    publishedAt: timestamp().nullable(),
  },
} as const
