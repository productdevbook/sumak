// POST /api/tasks — create a task. Nitro's `readBody()` parses
// JSON automatically; H3's error helpers pair with throw for clean
// 400 responses.

export default defineEventHandler(async (event) => {
  const body = await readBody<{ title?: string }>(event)
  if (!body.title || typeof body.title !== "string") {
    throw createError({ statusCode: 400, statusMessage: "title is required" })
  }

  const tid = Number(getCookie(event, "tid") ?? 1)
  const db = dbFor(tid)

  const [created] = await db
    .insertInto("tasks")
    .values({ tenantId: tid, title: body.title } as never)
    .returningAll()
    .many()

  setResponseStatus(event, 201)
  return created
})
