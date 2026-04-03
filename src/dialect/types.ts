import type { SQLDialect } from "../types.ts";
import type { Printer } from "../printer/types.ts";

export interface Dialect {
  name: SQLDialect;
  createPrinter(): Printer;
}
