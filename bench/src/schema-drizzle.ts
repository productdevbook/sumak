import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core"

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  createdAt: timestamp("createdAt").notNull(),
})

export const posts = pgTable("posts", {
  id: serial("id").primaryKey(),
  authorId: integer("authorId").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  published: integer("published").notNull(),
})

export const comments = pgTable("comments", {
  id: serial("id").primaryKey(),
  postId: integer("postId").notNull(),
  authorId: integer("authorId").notNull(),
  body: text("body").notNull(),
})
