"use server"

import { revalidatePath } from "next/cache"

import { currentTenantId } from "@/lib/auth"
import { dbFor } from "@/lib/db"

// Server Action — called directly from a form submit, no REST
// boilerplate. The tenant scope is re-established here because server
// actions don't share state with the Server Component that rendered
// the form; each action is its own request.
export async function toggleTask(formData: FormData) {
  const id = Number(formData.get("id"))
  if (!Number.isFinite(id)) return

  const tid = await currentTenantId()
  const db = dbFor(tid)

  // CASE WHEN inside the SET clause — toggle doneAt between null and
  // now() atomically. The multiTenant plugin adds `WHERE tenantId = $tid`
  // automatically, so even if `id` leaks across tenants the query
  // won't touch someone else's row.
  await db
    .update("tasks")
    .set({
      doneAt: ({ doneAt }) =>
        // sumak's raw expression helper — typed as Expression<Date|null>
        // so the assignment typechecks.
        doneAt.isNull().then(new Date()).else(null),
    } as never)
    .where(({ id: col }) => col.eq(id))
    .exec()

  revalidatePath("/")
}
