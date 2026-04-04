import { defineBuildConfig } from "obuild/config"

export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input: [
        "./src/index.ts",
        "./src/pg.ts",
        "./src/mysql.ts",
        "./src/sqlite.ts",
        "./src/schema.ts",
      ],
      minify: true,
    },
  ],
})
