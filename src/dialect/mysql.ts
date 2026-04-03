import { MysqlPrinter } from "../printer/mysql.ts";
import type { Dialect } from "./types.ts";

export function mysqlDialect(): Dialect {
  return {
    name: "mysql",
    createPrinter() {
      return new MysqlPrinter();
    },
  };
}
