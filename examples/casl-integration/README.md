# sumak + CASL

Row-level authorization with [CASL](https://casl.js.org/) — rules
compile straight into the SQL `WHERE` via sumak's AST-first pipeline.

## Shape

- `src/schema.ts` — tables (`posts`, `users`)
- `src/abilities.ts` — per-user `Ability` builder
- `src/db.ts` — `sumak()` instance wired with `caslAuthz` + `subjectType`
- `src/app.ts` — end-to-end usage: queries are automatically scoped

Nothing in this directory runs — it's a reference snippet, not a
full-stack demo. Copy the files you need into your own Express /
Fastify / Next.js app and replace the stub `currentUser()` with your
auth middleware's output.

## Pattern at a glance

```ts
// Ability: describe what a user can see/do.
const ability = defineAbilityFor(currentUser)
// can("read",   "Post", { authorId: currentUser.id })
// can("read",   "Post", { published: true })
// cannot("read", "Post", { status: "archived" })
// can("update", "Post", { authorId: currentUser.id })

// Plug it into sumak once — every query below picks up the WHERE.
const db = sumak({
  dialect: pgDialect(),
  driver: pgDriver(pool),
  tables,
  plugins: [
    caslAuthz({ ability, subjects: { posts: "Post" } }),
    subjectType({ tables: { posts: "Post" } }),
  ],
})

const visiblePosts = await db.selectFrom("posts").select("id", "title").many()
// SELECT "id", "title" FROM "posts"
// WHERE (("authorId" = $1 OR "published" = $2) AND NOT ("status" = $3))
//
// No per-callsite boilerplate; the filter is invisible to callers.

await db
  .update("posts")
  .set({ title: "updated" })
  .where(({ id }) => id.eq(7))
  .exec()
// UPDATE "posts" SET "title" = $1
// WHERE ("id" = $2) AND ("authorId" = $3)
//
// The `update` rule overrides the `read` rule's predicate —
// only the author's own post can be updated, enforced in SQL.
```

## Why this over calling `ability.can()` in app code?

- **No missed checks.** A new query path can't forget the filter —
  the plugin fires on every SELECT/UPDATE/DELETE for a mapped table.
- **Database-side filtering.** Rows you can't see never leave the
  database. Calling `ability.can()` on app-loaded rows still pulls
  unauthorized rows over the wire; `caslAuthz` prevents that.
- **Index-friendly.** Because the predicate lands in `WHERE`, the
  query planner can use your `authorId` / `published` indexes.
- **AST visibility.** EXPLAIN shows the filtered query, `onQuery`
  observability sees the full predicate, and the statement cache
  keys include the authz clause.

## Scope (v1)

The plugin covers **SELECT / UPDATE / DELETE** (+ their RETURNING
rows). INSERT is deliberately not touched — see the README section
on `caslAuthz` for the rationale.

Field-level permissions (`permittedFieldsOf` → SELECT column prune,
UPDATE SET key strip) are on the roadmap but not in v1.

## Supported operators

`eq`, `ne`, `in`, `nin`, `gt`, `gte`, `lt`, `lte`, `and`, `or`, `not`.
Rules using `regex`, `exists`, `elemMatch`, `all`, `size` throw
`UnsupportedCaslOperatorError` at compile time — fail-loud rather
than silent-skip.

## The utility path (no plugin)

If you'd rather opt in per-query:

```ts
import { caslToSumakWhere } from "sumak"

const where = caslToSumakWhere({ ability, action: "read", subject: "Post" })
const rows = await db
  .selectFrom("posts")
  .where(() => where)
  .many()
```

Same converter under the hood. Use the plugin when you want
transparent enforcement everywhere; use the utility when you want an
explicit authz-on/off split (e.g. admin endpoints).
