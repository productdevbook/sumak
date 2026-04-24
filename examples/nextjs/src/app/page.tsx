import { currentTenantId } from "@/lib/auth"
import { dbFor } from "@/lib/db"

import { toggleTask } from "./actions"

// Server Component — runs on the server, queries the DB directly, and
// streams HTML to the browser. The tenantId comes from the request's
// auth session; the multiTenant plugin on `dbFor(tid)` makes sure the
// WHERE clause is there even if we forget it.
export default async function TasksPage() {
  const tid = await currentTenantId()
  const db = dbFor(tid)

  const tasks = await db
    .selectFrom("tasks")
    .select("id", "title", "doneAt")
    .orderBy("createdAt", "DESC")
    .limit(100)
    .many()

  return (
    <main>
      <h1>Tasks</h1>
      <ul>
        {tasks.map((t) => (
          <li key={t.id}>
            <form action={toggleTask}>
              <input type="hidden" name="id" value={t.id} />
              <button type="submit">{t.doneAt ? "✓" : "○"}</button>
              <span style={{ textDecoration: t.doneAt ? "line-through" : "none" }}>{t.title}</span>
            </form>
          </li>
        ))}
      </ul>
    </main>
  )
}
