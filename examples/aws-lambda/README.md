# sumak + AWS Lambda

Lambda handler that writes an event to Postgres. The example is small on purpose — Lambda-specific plumbing (IAM, API Gateway, CDK/Terraform) is out of scope. What's here is the parts that matter for sumak:

1. **Module-level pool.** The `new Pool()` and `sumak()` call happen once per Lambda container, not once per invocation. A fresh pool per request would exhaust the RDS connection limit almost immediately.
2. **`max: 1`.** Lambda containers are single-threaded; one connection is the right default. It also acts as a natural per-function concurrency limiter.
3. **Short idle timeout.** RDS kills long-idle connections; Lambda freezes the process between invocations. A 10-second idle timeout keeps the pool from handing you a dead socket after a long quiet period.
4. **AbortSignal from Lambda's deadline.** `context.getRemainingTimeInMillis()` gives you the remaining budget. We convert it into an `AbortSignal` so an open query gets cancelled server-side rather than hitting Lambda's 15-minute kill.

## Cold-start notes

sumak's initialisation is pure TypeScript with no runtime code generation, so there's no per-cold-start compile step. The `compile-time` benchmark in the main repo shows query-build overhead at sub-microsecond levels — that's what shows up on your cold-start trace.

If you're running on provisioned concurrency and want to be extra sure the first request doesn't trip any lazy-initialisation, add a warmup line at module scope:

```ts
db.selectFrom("events").select("id").limit(1).compile() // primes AST paths
```

## Deploying

Use whatever your team prefers — SAM, CDK, Serverless Framework, Terraform, or plain `zip` + `aws lambda update-function-code`. This example deliberately doesn't pick one; the handler is what counts.
