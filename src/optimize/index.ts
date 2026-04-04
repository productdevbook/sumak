export { optimize, createRule } from "./optimizer.ts"
export { predicatePushdown, subqueryFlattening, removeWhereTrue, BUILTIN_RULES } from "./rules.ts"
export type { RewriteRule, OptimizeOptions } from "./types.ts"
