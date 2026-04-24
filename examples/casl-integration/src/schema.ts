import { integer, serial, text } from "sumak"

// Minimal two-table schema. `posts` is the CASL-protected subject;
// `users` is just here so the examples can show a JOIN or a lookup.
// `tenant_id` on posts is unused by CASL itself — it's there so the
// combined `caslAuthz + multiTenant` plugin example below has
// something to filter on.

export const tables = {
  posts: {
    id: serial().primaryKey(),
    title: text().notNull(),
    authorId: integer().notNull(),
    published: text(),
    status: text(),
    tenant_id: integer(),
  },
  users: {
    id: serial().primaryKey(),
    name: text().notNull(),
  },
}
