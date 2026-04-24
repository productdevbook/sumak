// PATCH /api/tasks/:id — toggle a task's completion. Honours the
// client-request AbortSignal so a disconnect cancels the query
// server-side instead of running against nothing.

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, "id"))
  if (!Number.isFinite(id)) {
    throw createError({ statusCode: 400, statusMessage: "invalid id" })
  }
  const tid = Number(getCookie(event, "tid") ?? 1)
  const db = dbFor(tid)

  // H3 exposes the incoming request's AbortSignal via `event.node.req`
  // — propagate it down to the driver so long-running updates get
  // cancelled if the client goes away.
  const signal = event.node.req.signal ?? undefined

  await db
    .update("tasks")
    .set({
      doneAt: ({ doneAt }) => doneAt.isNull().then(new Date()).else(null),
    } as never)
    .where(({ id: col }) => col.eq(id))
    .exec({ signal })

  return { ok: true }
})
