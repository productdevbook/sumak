import { Pool } from "pg"
import { defineConfig } from "sumak/cli"
import { pgDriver } from "sumak/drivers/pg"

import { tables } from "./server/utils/schema.ts"

export default defineConfig({
  dialect: "pg",
  driver: () => pgDriver(new Pool({ connectionString: process.env.DATABASE_URL })),
  schema: () => ({ tables }),
})
