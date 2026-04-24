import express from "express"

import { db } from "./db.ts"

const app = express()
app.use(express.json())

// GET /posts — page through published posts. Uses sumak's streaming
// API so large result sets don't balloon memory on the Node side.
app.get("/posts", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500)
  res.setHeader("content-type", "application/x-ndjson")

  const stream = db
    .selectFrom("posts")
    .select("id", "title", "publishedAt")
    .where(({ publishedAt }) => publishedAt.isNotNull())
    .orderBy("publishedAt", "DESC")
    .limit(limit)
    .stream()

  for await (const row of stream) {
    res.write(`${JSON.stringify(row)}\n`)
  }
  res.end()
})

// POST /posts — create a post, all inside one transaction so the
// author lookup and the insert share a consistent view.
app.post("/posts", async (req, res) => {
  const { authorEmail, title, body } = req.body as {
    authorEmail: string
    title: string
    body: string
  }

  try {
    const created = await db.transaction(async (tx) => {
      const [author] = await tx
        .selectFrom("users")
        .select("id")
        .where(({ email }) => email.eq(authorEmail))
        .limit(1)
        .many()
      if (!author) throw new Error(`Unknown author: ${authorEmail}`)

      const [inserted] = await tx
        .insertInto("posts")
        .values({ authorId: author.id, title, body, publishedAt: new Date() })
        .returningAll()
        .many()
      return inserted
    })
    res.status(201).json(created)
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

// DELETE /posts/:id — honours AbortSignal so a client disconnect
// cancels the underlying query instead of holding the connection.
app.delete("/posts/:id", async (req, res) => {
  const ac = new AbortController()
  req.on("close", () => ac.abort())

  const { affected } = await db
    .deleteFrom("posts")
    .where(({ id }) => id.eq(Number(req.params.id)))
    .exec({ signal: ac.signal })

  res.json({ deleted: affected })
})

const port = Number(process.env.PORT) || 3000
app.listen(port, () => {
  console.log(`listening on :${port}`)
})
