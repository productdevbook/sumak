# mvp — what the query path looks like if you start over

Throwaway. Not wired into `src/`, not exported, not shipped. It exists to answer one
question with a number instead of an argument.

## The one decision

Writing a query and running a query are two different phases, and the library should say
so.

```ts
// once, where the module is loaded
const findUser = db
  .from("users")
  .params(t.num)
  .pick("id", "name")
  .where((c, [id]) => c.users.id.eq(id))
  .build()

// per request
findUser.sql // 'SELECT "users"."id", "users"."name" FROM "users" WHERE ("users"."id" = $1)'
findUser.bind([42]) // the same array back, untouched
```

Everything else follows from that, including most of the simplification.

## What it costs

Nanoseconds per request to hand a driver the SQL and the parameters, measured against the
libraries in `devDependencies` (`mvp/measure/RESULTS.txt`, regenerate with
`MEASURE=1 pnpm vitest run mvp/measure`):

| scenario                | drizzle | kysely |   sumak | mvp |
| ----------------------- | ------: | -----: | ------: | --: |
| `select-all`            | 20259ns | 1399ns |  1349ns | 4.7 |
| `select-where-eq`       | 20050ns | 3377ns |  3216ns | 7.2 |
| `join-2-tables`         | 32837ns | 6168ns |  4652ns | 7.6 |
| `select-where-deep-and` | 62663ns | 8420ns | 10207ns | 8.2 |
| `update-where`          | 18169ns | 2775ns |  3170ns | 7.0 |
| **floor, no library**   |       — |      — |       — | 4.8 |

Read the last row first. It is the same loop with no query builder in it, and the mvp
column sits inside it — what is being measured there is the harness. The other three
libraries are rebuilding the query on every call; the mvp built it once, at startup, for
~2µs. Break-even is the first or second request.

`$n` names its argument rather than its position in the text, so `bind` is the identity
function and the array the caller already holds is the array the driver wants. Nothing is
allocated and nothing is copied.

`RESULTS.txt` also prints the SQL each library emits for each scenario, side by side, so
"they are doing the same work" can be checked rather than trusted.

## What disappears

Today's pipeline runs on every call, so every layer in it has been made fast, and the
speed is what makes it hard to read. Move the pipeline to definition time and the reasons
for that complexity go away:

| today                                                    | here                                        |
| -------------------------------------------------------- | ------------------------------------------- |
| immutable builders, spread-cloning a node per chain step | a mutable spec; it is built once            |
| identity-preserving recursion so no-op passes stay cheap | passes may allocate freely                  |
| a fixpoint loop capped for the sake of the hot path      | run it to a fixpoint, nobody is waiting     |
| `Proxy` per `.where()`, `Col` per column access          | one frozen column map per table, at startup |
| plugin dispatch, hook dispatch, per compile              | at definition                               |
| a plan cache, a shape key, invalidation, eviction        | there is nothing to cache                   |

## The rules that keep it honest

Five, all pinned by `mvp.test.ts` and `security.test.ts`:

1. **A value cannot become SQL.** `Operand<T>` does not admit a bare `T`, so
   `.eq(userInput)` is a compile error. Either it is a parameter, or it is an explicit
   `lit(...)` — a deliberate, greppable act. `lit` escapes both the quote and the
   backslash, which mysql reads as an escape character.
2. **A statement has only its own clauses.** `Select` / `Insert` / `Update` / `Delete` are
   separate types; `insertInto("users").groupBy(...)` does not compile.
3. **Parameters are declared, not discovered.** `.params(t.num, t.text)` fixes the
   argument tuple, and the `where` callback receives them positionally.
4. **The row type comes out of the builder too**, not only out of the string form.
5. **Brands are required and unique.** An optional `__param?: T` is not a brand — `Lit<1>`
   was structurally assignable to `Param<string>` until the marker became a required
   `unique symbol`.

## What it cannot do

- Composition. A filter present on some requests and not others is two queries, or a
  `WHERE ($1 IS NULL OR …)`. The builder can assemble that at definition time; nothing
  here assembles it per request.
- `sql.ts` writes `$1` by hand and is Postgres-shaped. The builder handles positional
  dialects (`mysql`); the string form does not.
- The string form's type-level parser understands `SELECT … FROM t` and stops there. Joins
  and expressions widen the row to `unknown` rather than failing, so a wrong column name
  in a join is not caught. Type-level parsing is also paid by everyone running `tsc`.
- No driver, no result mapping, no DDL, no migrations, no introspection, no plugins.

A note on the string form: a tagged template cannot carry its literal parts into the type
system — TypeScript widens them to `readonly string[]` — so `sql.ts` takes a plain string
argument instead. That is also the safer shape: with no interpolation there is nowhere for
a value to be spliced in.

## Where the time actually goes

Worth reading before optimising anything else here. Against pglite a query returning one
row costs ~328µs end to end, and sumak's entire compile is ~1% of that. What stable SQL
text buys is bigger: the same query runs in 243µs as a `PREPARE`d statement against 303µs
without, and that 60µs is twenty times the compile cost. The measurements are in
`mvp/measure/REALITY.txt` and `mvp/measure/PLANCACHE.txt`.

So the next thing this needs is not a faster compiler. It is a driver that keeps named
prepared statements, and a result path compiled at definition time the way the query is.

## Run

```bash
pnpm vitest run mvp                      # correctness
MEASURE=1 pnpm vitest run mvp/measure    # the numbers above
```
