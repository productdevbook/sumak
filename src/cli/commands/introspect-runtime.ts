import type { Driver } from "../../driver/types.ts"
import type { SchemaDef } from "../../migrate/diff.ts"

/**
 * Runtime adapter: read the live database via the dialect-specific
 * introspector and return a `SchemaDef` the migrate diff engine can
 * consume.
 *
 * This is a best-effort round-trip — the introspector recovers what
 * the catalogs know, which is strictly less than the TypeScript schema
 * can express (no function-generated defaults, no plugin flags, and
 * the default expressions are strings rather than typed builders).
 * For the CLI migrate path this is enough: the diff only compares
 * shape (name, type, nullable, keys, FKs, indexes), not the
 * TypeScript-only affordances.
 *
 * Today this returns `{}` — meaning the CLI treats the live database
 * as empty and emits CREATE TABLE for everything. That's safe for a
 * first-run / green-field migration, and is the common case for the
 * projects adopting the CLI early. Full round-trip — turning an
 * `IntrospectedSchema` back into a `SchemaDef` for non-destructive
 * diffing — is tracked as follow-up work.
 */
export async function introspectForMigrate(
  _driver: Driver,
  _dialect: string,
  _namespace?: string,
): Promise<SchemaDef> {
  return {}
}
