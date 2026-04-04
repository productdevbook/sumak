import { defineBuildConfig } from "obuild/config"

export default defineBuildConfig({
  entries: [
    { type: "bundle", input: "./src/index.ts" },
    { type: "bundle", input: "./src/pg.ts" },
    { type: "bundle", input: "./src/mssql.ts" },
    { type: "bundle", input: "./src/mysql.ts" },
    { type: "bundle", input: "./src/sqlite.ts" },
    { type: "bundle", input: "./src/schema.ts" },
  ],
})
