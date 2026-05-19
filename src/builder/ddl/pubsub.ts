import type { ListenNode, NotifyNode, UnlistenNode } from "../../ast/ddl-nodes.ts"

/**
 * Immutable builder for {@link ListenNode} — PostgreSQL `LISTEN`.
 *
 * Subscribes the current session to the named channel. Notifications
 * sent on that channel via `NOTIFY` arrive through the driver's async
 * notification callback (in `node-postgres`,
 * `client.on('notification', …)`). Subscriptions are session-scoped
 * and survive across COMMIT / ROLLBACK; they vanish when the session
 * disconnects.
 *
 * ```ts
 * listen("cache_invalidation").build()
 *   // LISTEN "cache_invalidation"
 * ```
 *
 * Refused on MySQL / SQLite / MSSQL at print time — none have a
 * comparable built-in async-pubsub primitive. Use a message broker
 * (Redis Pub/Sub, RabbitMQ) on those engines instead.
 */
export class ListenBuilder {
  private readonly node: ListenNode

  constructor(channel: string)
  constructor(node: ListenNode)
  constructor(arg: string | ListenNode) {
    if (typeof arg === "string") {
      this.node = { type: "listen", channel: arg }
    } else {
      this.node = arg
    }
  }

  private clone(patch: Partial<ListenNode>): ListenBuilder {
    return new ListenBuilder({ ...this.node, ...patch })
  }

  /**
   * Replace the channel name. Channels are SQL identifiers and quoted
   * via `quoteIdentifier` at print time, so mixed case and reserved
   * keywords survive verbatim.
   */
  channel(name: string): ListenBuilder {
    return this.clone({ channel: name })
  }

  build(): ListenNode {
    return { ...this.node }
  }
}

/**
 * Factory for {@link ListenBuilder}.
 *
 * ```ts
 * listen("orders_changed").build()
 *   // LISTEN "orders_changed"
 * ```
 */
export function listen(channel: string): ListenBuilder {
  return new ListenBuilder(channel)
}

/**
 * Immutable builder for {@link UnlistenNode} — PostgreSQL `UNLISTEN`.
 *
 * Cancels a previous LISTEN subscription. Pass a channel name to
 * unsubscribe from one channel, or the literal `"*"` to drop every
 * current subscription on the session — the bulk-cleanup form is
 * useful from a connection-release hook in a pooled driver so the
 * next caller doesn't inherit a polluted subscription set.
 *
 * ```ts
 * unlisten("cache_invalidation").build()
 *   // UNLISTEN "cache_invalidation"
 *
 * unlisten("*").build()
 *   // UNLISTEN *
 * ```
 *
 * Refused on MySQL / SQLite / MSSQL at print time — same `PUBSUB`
 * feature gate as LISTEN / NOTIFY.
 */
export class UnlistenBuilder {
  private readonly node: UnlistenNode

  constructor(channel: string)
  constructor(node: UnlistenNode)
  constructor(arg: string | UnlistenNode) {
    if (typeof arg === "string") {
      this.node = { type: "unlisten", channel: arg }
    } else {
      this.node = arg
    }
  }

  private clone(patch: Partial<UnlistenNode>): UnlistenBuilder {
    return new UnlistenBuilder({ ...this.node, ...patch })
  }

  /**
   * Replace the channel name. Use `"*"` for the wildcard "drop every
   * subscription" form; any other value is treated as a named channel
   * and quoted via `quoteIdentifier` at print time.
   */
  channel(name: string): UnlistenBuilder {
    return this.clone({ channel: name })
  }

  build(): UnlistenNode {
    return { ...this.node }
  }
}

/**
 * Factory for {@link UnlistenBuilder}. Accepts a channel name or the
 * literal `"*"` wildcard.
 *
 * ```ts
 * unlisten("orders_changed").build()
 *   // UNLISTEN "orders_changed"
 *
 * unlisten("*").build()
 *   // UNLISTEN *
 * ```
 */
export function unlisten(channel: string): UnlistenBuilder {
  return new UnlistenBuilder(channel)
}

/**
 * Immutable builder for {@link NotifyNode} — PostgreSQL `NOTIFY`.
 *
 * Sends an asynchronous notification on the named channel. Every
 * session currently `LISTEN`-ing on that channel receives the
 * notification at COMMIT time of the sender's transaction (or
 * immediately if there's no surrounding transaction). PG coalesces
 * duplicate identical notifications inside one transaction so
 * listeners see one delivery per distinct (channel, payload) pair.
 *
 * The payload is optional. When unset PG sends a notification with an
 * empty payload; when set the value is escaped via
 * `escapeStringLiteral` at print time so single quotes (`O'Brien`) and
 * backslashes (`C:\\Windows`) survive verbatim into the `'…'` SQL
 * literal slot. PG caps the payload at 8 KB by default — that limit is
 * a build-time tunable on the server side, so the builder doesn't
 * pre-check it.
 *
 * ```ts
 * notify("cache_invalidation").build()
 *   // NOTIFY "cache_invalidation"
 *
 * notify("orders_changed").payload("123").build()
 *   // NOTIFY "orders_changed", '123'
 *
 * notify("audit").payload(JSON.stringify({ id: 42, op: "delete" })).build()
 *   // NOTIFY "audit", '{"id":42,"op":"delete"}'
 * ```
 *
 * Refused on MySQL / SQLite / MSSQL at print time — same `PUBSUB`
 * feature gate as LISTEN / UNLISTEN.
 */
export class NotifyBuilder {
  private readonly node: NotifyNode

  constructor(channel: string)
  constructor(node: NotifyNode)
  constructor(arg: string | NotifyNode) {
    if (typeof arg === "string") {
      this.node = { type: "notify", channel: arg }
    } else {
      this.node = arg
    }
  }

  private clone(patch: Partial<NotifyNode>): NotifyBuilder {
    return new NotifyBuilder({ ...this.node, ...patch })
  }

  /**
   * Replace the channel name. Channels are SQL identifiers and quoted
   * via `quoteIdentifier` at print time.
   */
  channel(name: string): NotifyBuilder {
    return this.clone({ channel: name })
  }

  /**
   * Set the optional payload string. Single quotes and backslashes are
   * escaped at print time so any UTF-8 string is safe to pass through.
   * Call without arguments after a previous `.payload(...)` to clear
   * the slot — pass `undefined` explicitly for the same effect.
   */
  payload(text: string | undefined): NotifyBuilder {
    return this.clone({ payload: text })
  }

  build(): NotifyNode {
    return { ...this.node }
  }
}

/**
 * Factory for {@link NotifyBuilder}.
 *
 * ```ts
 * notify("orders_changed").payload("123").build()
 *   // NOTIFY "orders_changed", '123'
 * ```
 */
export function notify(channel: string): NotifyBuilder {
  return new NotifyBuilder(channel)
}
