import { integer, serial, text, timestamp } from "../../src/schema/index.ts"

/**
 * Shared benchmark schema mirrored across sumak / drizzle / kysely.
 * Small enough to be realistic (three tables, one FK), large enough
 * to exercise column lists, joins, and WHERE predicates.
 */
export const tables = {
  users: {
    id: serial().primaryKey(),
    name: text().notNull(),
    email: text().notNull().unique(),
    createdAt: timestamp().notNull(),
  },
  posts: {
    id: serial().primaryKey(),
    authorId: integer().notNull().references("users", "id"),
    title: text().notNull(),
    body: text().notNull(),
    published: integer().notNull(),
  },
  comments: {
    id: serial().primaryKey(),
    postId: integer().notNull().references("posts", "id"),
    authorId: integer().notNull().references("users", "id"),
    body: text().notNull(),
  },
} as const
