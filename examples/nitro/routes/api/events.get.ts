// GET /api/events — list the most recent events, paginated by a
// ?before=<seq> cursor. Demonstrates streaming straight into the
// H3 response via Nitro's `send` helper + an async iterable.

export default defineEventHandler(async (event) => {
  const before = Number(getQuery(event).before ?? Number.MAX_SAFE_INTEGER)
  const limit = Math.min(Number(getQuery(event).limit ?? 50), 500)

  return db
    .selectFrom("events")
    .select("id", "source", "payload", "occurredAt", "seq")
    .where(({ seq }) => seq.lt(before))
    .orderBy("seq", "DESC")
    .limit(limit)
    .many()
})
