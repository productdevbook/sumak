import { AbilityBuilder, createMongoAbility } from "@casl/ability"
import type { MongoAbility } from "@casl/ability"

// Shape of the current-user context your auth middleware hands in.
// Keep it lean — anything you reference here (id, roles, tenant) must
// be stable across the lifetime of the Ability.
export interface CurrentUser {
  id: number
  roles: ("reader" | "author" | "moderator")[]
}

// A CASL Action × Subject tuple. `as const` on the strings keeps
// TypeScript honest about which rule names exist; pair this with the
// `caslAuthz({ actions: { ... } })` option if you use non-default
// verbs.
type Actions = "read" | "update" | "delete" | "create"
type Subjects = "Post" | "User"
export type AppAbility = MongoAbility<[Actions, Subjects]>

/**
 * Build a per-request Ability for the given user. Called once per
 * request (do NOT cache across users) and fed into the sumak
 * `caslAuthz` plugin in src/db.ts.
 */
export function defineAbilityFor(user: CurrentUser): AppAbility {
  const { can, cannot, build } = new AbilityBuilder<AppAbility>(createMongoAbility)

  // Readers see published posts and their own drafts.
  can("read", "Post", { published: "yes" })
  can("read", "Post", { authorId: user.id })

  // Archived posts are always hidden — even from the author. This
  // `cannot` rule compiles to `AND NOT ("status" = $n)` on top of the
  // positive rules above.
  cannot("read", "Post", { status: "archived" })

  // Authors can edit and delete their own posts.
  if (user.roles.includes("author")) {
    can("update", "Post", { authorId: user.id })
    can("delete", "Post", { authorId: user.id })
  }

  // Moderators override the author scope — they can edit anyone's
  // posts. This is an unconditional `can`, so it compiles to no
  // WHERE at all (every row allowed) for moderator sessions.
  if (user.roles.includes("moderator")) {
    can("update", "Post")
  }

  // Users are readable by anyone, editable only by themselves.
  can("read", "User")
  can("update", "User", { id: user.id })

  return build()
}
