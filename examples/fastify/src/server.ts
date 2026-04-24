import Fastify from "fastify"
import { Pool } from "pg"
import { sumak } from "sumak"
import { pgDriver } from "sumak/drivers/pg"
import { pgDialect } from "sumak/pg"

import { tables } from "./schema.ts"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const db = sumak({ dialect: pgDialect(), driver: pgDriver(pool), tables })

const app = Fastify({ logger: true })

// Fastify's schema-driven validation catches bad input at the edge;
// sumak's type layer catches bad queries at compile time. The two
// meet at the handler — the body is fully typed and maps straight
// onto `.values({...})`.
app.post<{ Body: { sku: string; name: string; priceCents: number } }>(
  "/products",
  {
    schema: {
      body: {
        type: "object",
        required: ["sku", "name", "priceCents"],
        properties: {
          sku: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          priceCents: { type: "integer", minimum: 1 },
        },
      },
    },
  },
  async (req, reply) => {
    const [created] = await db.insertInto("products").values(req.body).returningAll().many()
    reply.code(201)
    return created
  },
)

// GET /products/:sku — parameter is type-narrowed via Fastify's
// schema, and sumak's column reference (`sku`) is type-narrowed
// against the `products` table record.
app.get<{ Params: { sku: string } }>("/products/:sku", async (req, reply) => {
  const [product] = await db
    .selectFrom("products")
    .selectAll()
    .where(({ sku }) => sku.eq(req.params.sku))
    .limit(1)
    .many()
  if (!product) {
    reply.code(404)
    return { error: "not found" }
  }
  return product
})

app.listen({ port: Number(process.env.PORT) || 3000 })
