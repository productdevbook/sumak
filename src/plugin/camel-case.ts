import type { SumakPlugin } from "./types.ts";

/**
 * Plugin that converts snake_case result column names to camelCase.
 *
 * This plugin operates on results only — it does NOT transform the AST.
 * Use it when your database uses snake_case but your TypeScript code uses camelCase.
 */
export class CamelCasePlugin implements SumakPlugin {
  readonly name = "camel-case";

  transformResult(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    return rows.map((row) => {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(row)) {
        result[toCamelCase(key)] = row[key];
      }
      return result;
    });
  }
}

function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}
