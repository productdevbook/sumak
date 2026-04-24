// GET /api/tasks — list tasks for the current tenant. Nitro picks
// up the filename suffix (.get) as the HTTP method. Returns JSON by
// default; no res.json() / res.end() dance.

export default defineEventHandler(async (event) => {
  // Stand-in tenant resolution. In a real app, decode the session
  // from `event` (cookies via `parseCookies(event)` / JWT header /
  // whatever your auth provider uses).
  const tid = Number(getCookie(event, "tid") ?? 1)
  const db = dbFor(tid)

  return db
    .selectFrom("tasks")
    .select("id", "title", "doneAt")
    .orderBy("createdAt", "DESC")
    .limit(100)
    .many()
})
