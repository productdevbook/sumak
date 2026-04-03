import { SqlitePrinter } from "../printer/sqlite.ts";
import type { Dialect } from "./types.ts";

export function sqliteDialect(): Dialect {
  return {
    name: "sqlite",
    createPrinter() {
      return new SqlitePrinter();
    },
  };
}
