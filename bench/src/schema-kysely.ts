/**
 * Kysely is driver-agnostic; the schema is purely a TypeScript
 * `DatabaseSchema` interface. Column names match the sumak/drizzle
 * versions so the compiled SQL is directly comparable.
 */
export interface BenchDatabase {
  users: {
    id: number
    name: string
    email: string
    createdAt: Date
  }
  posts: {
    id: number
    authorId: number
    title: string
    body: string
    published: number
  }
  comments: {
    id: number
    postId: number
    authorId: number
    body: string
  }
}
