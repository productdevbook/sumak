import { defineAbilityFor } from "./abilities.ts"
import { makeDb } from "./db.ts"

// Pretend these come from your auth middleware.
const currentUser = { id: 42, roles: ["author"] as const }

async function main() {
  const ability = defineAbilityFor(currentUser)
  const db = makeDb(ability)

  // 1) Plain SELECT — caslAuthz adds the CASL predicate invisibly.
  //    Emits:
  //      SELECT "id", "title" FROM "posts"
  //      WHERE (("published" = $1 OR "authorId" = $2) AND NOT ("status" = $3))
  const posts = await db.selectFrom("posts").select("id", "title").many()
  console.log("visible posts:", posts.length)

  // 2) SELECT with user predicate — ANDs with CASL predicate.
  //    Emits:
  //      SELECT "id", "title" FROM "posts"
  //      WHERE ("title" LIKE $1) AND (…CASL…)
  const matching = await db
    .selectFrom("posts")
    .select("id", "title")
    .where(({ title }) => title.like("%draft%"))
    .many()
  console.log("matching drafts:", matching.length)

  // 3) UPDATE — switches to the "update" action's CASL predicate
  //    (authorId-scoped), enforced in SQL. Callers who don't own the
  //    post silently affect zero rows.
  const updated = await db
    .update("posts")
    .set({ title: "renamed" })
    .where(({ id }) => id.eq(7))
    .exec()
  console.log("rows updated:", updated.affected)

  // 4) Forbidden action — throws ForbiddenByCaslError at toSQL() time.
  //    Catch at your error boundary; the thrown error carries
  //    `action` + `subject` for audit logs.
  try {
    await db
      .deleteFrom("posts")
      .where(({ id }) => id.eq(1))
      .exec()
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenByCaslError") {
      console.warn("authz: delete blocked by CASL")
    } else {
      throw err
    }
  }

  // 5) Result stamping (from subjectType). Rows carry __typename so
  //    downstream code can run `ability.can("update", row)` without
  //    manually wrapping with CASL's `subject("Post", row)` helper.
  //
  //    import { subject } from "@casl/ability"   // not needed anymore
  //    ability.can("update", posts[0])   // works — __typename === "Post"
}

void main()
