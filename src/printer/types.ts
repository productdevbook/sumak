import type { CompiledQuery, SQLDialect } from "../types.ts";

export interface PrinterOptions {
  dialect: SQLDialect;
  prettyPrint?: boolean;
  indent?: string;
}

export interface Printer {
  print(node: import("../ast/nodes.ts").ASTNode): CompiledQuery;
}
