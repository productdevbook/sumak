// POST /api/events — ingest an event. The `seq` column is a
// monotonic counter that must be unique per source; sumak's
// transaction helper keeps the read of MAX(seq) and the INSERT on
// the same connection so two racing producers can't hand out the
// same sequence number.

interface EventBody {
  source: string
  payload: unknown
}

export default defineEventHandler(async (event) => {
  const body = await readBody<EventBody>(event)
  if (!body.source) {
    throw createError({ statusCode: 400, statusMessage: "source is required" })
  }

  return db.transaction(async (tx) => {
    const [max] = await tx
      .selectFrom("events")
      .select(({ seq }) => seq.max().as("maxSeq"))
      .where(({ source }) => source.eq(body.source))
      .many()
    const nextSeq = (max?.maxSeq ?? 0) + 1

    const [created] = await tx
      .insertInto("events")
      .values({
        source: body.source,
        payload: JSON.stringify(body.payload),
        seq: nextSeq,
      } as never)
      .returningAll()
      .many()
    setResponseStatus(event, 201)
    return created
  })
})
