import { PgPrinter } from "../printer/pg.ts";
import type { Dialect } from "./types.ts";

export function pgDialect(): Dialect {
  return {
    name: "pg",
    createPrinter() {
      return new PgPrinter();
    },
  };
}
