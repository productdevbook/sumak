import type { CompiledQuery, SQLDialect } from "../types.ts";

export type PrintMode = "compact" | "formatted" | "debug";

export interface PrinterOptions {
  dialect: SQLDialect;
  mode?: PrintMode;
  indent?: string;
  width?: number;
}

export interface Printer {
  print(node: import("../ast/nodes.ts").ASTNode): CompiledQuery;
}
