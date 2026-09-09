import type { ImapFlow } from 'imapflow';

/**
 * How long a pooled IMAP connection may sit unused before it is probed.
 *
 * `ImapFlow.usable` only goes false once the socket reports an error or close.
 * A connection dropped silently — Gmail reaping an idle session, a NAT or
 * firewall expiring the mapping without an RST — stays `usable`, so the next
 * tool call issues its command into a dead socket and blocks until something
 * times out. The failure then fires 'close', the entry is invalidated, and the
 * user's retry succeeds instantly: the intermittent stall that reads as "the
 * server is slow".
 */
const IDLE_BEFORE_PROBE_MS = Number(process.env.MCP_EMAIL_IMAP_IDLE_PROBE_MS ?? 60_000);

/**
 * One connection in an account's pool.
 *
 * `ready` is present from the moment the slot is reserved, before the socket is
 * up. Reserving synchronously is what makes a burst spread out: twenty tasks
 * dispatched in one tick all observe an empty pool otherwise, and every one of
 * them joins the same connection.
 */
export default class PooledImapConnection {
  /** Resolves when the socket is up; assigned the moment the slot is reserved. */
  ready: Promise<ImapFlow> = Promise.reject(new Error('not started'));

  /** Set once connected; absent while still opening or after a failure. */
  client?: ImapFlow;

  /** Tasks currently running on this connection. */
  inFlight = 0;

  /** When it last finished a task, for idle probing. */
  lastUsedAt = Date.now();

  /** A probe or reconnect in progress, so concurrent callers share one. */
  private revalidating?: Promise<ImapFlow>;

  constructor() {
    // Nothing awaits `ready` before startOpening replaces it, but an unhandled
    // rejection would be reported all the same.
    this.ready.catch(() => undefined);
  }

  /**
   * Begin connecting into this slot. Read the result from `ready`.
   *
   * The spare `catch` matters: a slot is opened before anyone necessarily
   * awaits it, and a connection that fails — an unreachable host, a refused
   * port — would otherwise surface as an unhandled rejection and take the
   * process down, rather than reaching the caller that eventually awaits
   * `ready`. Attaching a handler here does not swallow it: every real awaiter
   * still sees the rejection.
   */
  startOpening(open: () => Promise<ImapFlow>): void {
    const attempt = open();
    this.ready = attempt;
    attempt.catch(() => undefined);
  }

  attach(client: ImapFlow): void {
    this.client = client;
    this.lastUsedAt = Date.now();
  }

  detach(): void {
    this.client = undefined;
  }

  markUsed(): void {
    this.lastUsedAt = Date.now();
  }

  beginTask(): void {
    this.inFlight += 1;
  }

  endTask(): void {
    this.inFlight -= 1;
    this.lastUsedAt = Date.now();
  }

  /** Has this connection sat unused long enough that it may have been dropped? */
  isStale(): boolean {
    if (IDLE_BEFORE_PROBE_MS <= 0) return false;
    return Date.now() - this.lastUsedAt > IDLE_BEFORE_PROBE_MS;
  }

  /** True when the connection is known good and needs no probe. */
  isFresh(): boolean {
    return Boolean(this.client?.usable) && !this.isStale();
  }

  /**
   * Share one probe or reconnect among concurrent callers.
   *
   * Without this, five callers arriving together on an idle connection each
   * send their own NOOP to answer the same question.
   */
  async revalidateOnce(revalidate: () => Promise<ImapFlow>): Promise<ImapFlow> {
    if (!this.revalidating) {
      const attempt = revalidate();
      this.revalidating = attempt;
      attempt
        .catch(() => undefined)
        .finally(() => {
          // Guarded on identity: a newer attempt must not be cleared by an
          // older one settling late.
          if (this.revalidating === attempt) this.revalidating = undefined;
        });
    }
    return this.revalidating;
  }
}
