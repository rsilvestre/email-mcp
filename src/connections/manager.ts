/**
 * Connection manager for lazy-persistent IMAP and SMTP connections.
 *
 * - Creates connections on first use per account
 * - Reuses open connections across tool calls
 * - Auto-reconnects on failure
 * - Graceful shutdown closes all connections
 */

import { ImapFlow } from 'imapflow';
import type { Transporter } from 'nodemailer';
import nodemailer from 'nodemailer';
import { mcpLog } from '../logging.js';

import type OAuthService from '../services/oauth.service.js';
import type { AccountConfig } from '../types/index.js';
import buildImapAuth from './auth.js';
import PooledImapConnection from './pooled-connection.js';
import type { IConnectionManager } from './types.js';

type SmtpAuth =
  | { user: string; pass?: string }
  | { type: string; user: string; accessToken: string };

/** How long the liveness probe itself may take before the connection is rebuilt. */
const PROBE_TIMEOUT_MS = Number(process.env.MCP_EMAIL_IMAP_PROBE_TIMEOUT_MS ?? 5_000);

/**
 * Opt out of COMPRESS=DEFLATE.
 *
 * Compression is on by default and worth having. It does make transferred
 * bytes unmeasurable from outside, though: the deflate stream keeps its
 * dictionary for the life of the connection, so repeating a request costs
 * almost nothing on the wire regardless of payload size. Turn it off to see
 * real payload sizes when profiling or reading a proxy trace.
 */
const DISABLE_COMPRESSION = process.env.MCP_EMAIL_IMAP_DISABLE_COMPRESSION === 'true';

/**
 * Most IMAP connections opened for one account.
 *
 * imapflow serialises commands on a connection and getMailboxLock serialises on
 * top of that, so every Promise.all over IMAP work runs single file on one
 * socket. Extra connections are opened only when work is actually waiting, and
 * never for sequential use. Servers cap simultaneous connections per account
 * (Gmail allows 15), so this stays small.
 */
const POOL_MAX = Math.max(1, Number(process.env.MCP_EMAIL_IMAP_POOL_SIZE ?? 3));

export default class ConnectionManager implements IConnectionManager {
  /** Connections per account, each possibly still opening. */
  private imapPools = new Map<string, PooledImapConnection[]>();

  private smtpTransports = new Map<string, Transporter>();

  private accounts = new Map<string, AccountConfig>();

  private oauthService?: OAuthService;

  constructor(accounts: AccountConfig[], oauthService?: OAuthService) {
    accounts.forEach((account) => {
      this.accounts.set(account.name, account);
    });
    this.oauthService = oauthService;
  }

  // -------------------------------------------------------------------------
  // Account lookup
  // -------------------------------------------------------------------------

  getAccount(name: string): AccountConfig {
    const account = this.accounts.get(name);
    if (!account) {
      throw new Error(
        `Account "${name}" not found. Available: ${[...this.accounts.keys()].join(', ')}`,
      );
    }
    return account;
  }

  getAccountNames(): string[] {
    return [...this.accounts.keys()];
  }

  // -------------------------------------------------------------------------
  // IMAP
  // -------------------------------------------------------------------------

  /** Take a connection out of its account's pool, if it is still there. */
  private removeFromPool(accountName: string, entry: PooledImapConnection): void {
    const pool = this.imapPools.get(accountName);
    if (!pool) return;
    const index = pool.indexOf(entry);
    if (index !== -1) pool.splice(index, 1);
    if (pool.length === 0) this.imapPools.delete(accountName);
  }

  /** Drop a connection from its pool once the socket reports it is gone. */
  private registerImapLifecycle(
    accountName: string,
    client: ImapFlow,
    entry: PooledImapConnection,
  ): void {
    // Guarded on identity: a late error from a replaced connection must not
    // evict the one that took its place.
    const removeIfCurrent = () => {
      this.removeFromPool(accountName, entry);
    };

    client.on('error', (err) => {
      removeIfCurrent();
      mcpLog(
        'error',
        'imap',
        `Connection error for "${accountName}": ${err instanceof Error ? err.message : String(err)}`,
      ).catch(() => undefined);
    });

    client.on('close', removeIfCurrent);
  }

  /**
   * Confirm a connection still answers, within a bounded time.
   *
   * NOOP is the cheapest command that proves the round trip works. The race is
   * what makes this worth doing: a dead socket typically does not reject, it
   * simply never answers, so waiting on the NOOP alone would reproduce the very
   * stall this is meant to avoid.
   */
  private static async respondsToProbe(client: ImapFlow): Promise<boolean> {
    let probeTimer: NodeJS.Timeout | undefined;
    try {
      const timedOut = new Promise<false>((resolve) => {
        probeTimer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
        probeTimer.unref?.();
      });
      return await Promise.race([client.noop().then(() => true), timedOut]);
    } catch {
      return false;
    } finally {
      if (probeTimer) clearTimeout(probeTimer);
    }
  }

  /**
   * Reserve a pool slot and start connecting into it.
   *
   * The entry is pushed before the first await so that callers dispatched in
   * the same tick see the pool growing. Waiting until the socket was up would
   * make every one of them observe an empty pool and pile onto one connection.
   */
  private addImapConnection(accountName: string): PooledImapConnection {
    const pool = this.imapPools.get(accountName) ?? [];
    if (!this.imapPools.has(accountName)) this.imapPools.set(accountName, pool);

    const entry = new PooledImapConnection();
    pool.push(entry);

    entry.startOpening(async () => this.openImapClientOrReleaseSlot(accountName, entry));

    return entry;
  }

  /**
   * Pick the connection to run work on.
   *
   * `allowGrowth` separates the two kinds of caller. withImapClient knows when
   * its work finishes and so can justify another socket; getImapClient hands
   * out a connection with no idea how long it will be used, and opening one per
   * sequential call would be pure cost.
   */
  private selectImapConnection(accountName: string, allowGrowth: boolean): PooledImapConnection {
    const pool = this.imapPools.get(accountName) ?? [];
    const leastLoaded = pool.reduce<PooledImapConnection | undefined>(
      (best, entry) => (best === undefined || entry.inFlight < best.inFlight ? entry : best),
      undefined,
    );

    if (leastLoaded === undefined) {
      return this.addImapConnection(accountName);
    }
    if (allowGrowth && leastLoaded.inFlight > 0 && pool.length < POOL_MAX) {
      return this.addImapConnection(accountName);
    }
    return leastLoaded;
  }

  /**
   * Await a slot's connection, probing it first if it has been sitting idle.
   *
   * The probe is shared: without this, five callers arriving together on an
   * idle connection each send their own NOOP to answer the same question.
   */
  private async resolveImapConnection(
    accountName: string,
    entry: PooledImapConnection,
  ): Promise<ImapFlow> {
    // Connected and used recently — nothing to check.
    if (entry.isFresh() && entry.client) {
      entry.markUsed();
      return entry.client;
    }

    return entry.revalidateOnce(async () => this.revalidateImapConnection(accountName, entry));
  }

  /** Probe a slot's connection and rebuild it if it does not answer. */
  private async revalidateImapConnection(
    accountName: string,
    entry: PooledImapConnection,
  ): Promise<ImapFlow> {
    const client = await entry.ready;

    if (client.usable) {
      if (!entry.isStale()) {
        entry.markUsed();
        return client;
      }
      if (await ConnectionManager.respondsToProbe(client)) {
        entry.markUsed();
        return client;
      }
    }

    await mcpLog(
      'info',
      'imap',
      `Idle connection for "${accountName}" did not answer; reconnecting`,
    );

    try {
      client.close();
    } catch {
      /* ignore */
    }

    // Rebuild in place where the slot survived, so a caller already holding it
    // keeps its position in the pool. A 'close' listener may have removed it.
    const pool = this.imapPools.get(accountName);
    if (!pool?.includes(entry)) {
      const replacement = this.selectImapConnection(accountName, false);
      return this.resolveImapConnection(accountName, replacement);
    }

    entry.detach();
    entry.startOpening(async () => this.openImapClient(accountName, entry));
    return entry.ready;
  }

  /**
   * The account's IMAP connection, for work whose duration is not tracked.
   *
   * Never opens a second connection: a caller that only holds a client cannot
   * say when it is done with it, so growing here would open sockets that
   * nothing measures the need for.
   */
  async getImapClient(accountName: string): Promise<ImapFlow> {
    const entry = this.selectImapConnection(accountName, false);
    return this.resolveImapConnection(accountName, entry);
  }

  /**
   * Run one unit of IMAP work, spreading concurrent work across connections.
   *
   * This is what makes a Promise.all over IMAP calls actually concurrent.
   * Holding the task means the pool knows when a connection frees up, which is
   * what justifies opening another.
   */
  async withImapClient<T>(accountName: string, task: (client: ImapFlow) => Promise<T>): Promise<T> {
    const entry = this.selectImapConnection(accountName, true);
    entry.beginTask();
    try {
      const client = await this.resolveImapConnection(accountName, entry);
      return await task(client);
    } finally {
      entry.endTask();
    }
  }

  /**
   * Open into a reserved slot, freeing the slot if the connection never comes up.
   *
   * A slot left holding a rejected promise would be joined by every later
   * caller, and the account would never recover.
   */
  private async openImapClientOrReleaseSlot(
    accountName: string,
    entry: PooledImapConnection,
  ): Promise<ImapFlow> {
    try {
      return await this.openImapClient(accountName, entry);
    } catch (err) {
      this.removeFromPool(accountName, entry);
      throw err;
    }
  }

  /** Build and connect a client into an already-reserved pool slot. */
  private async openImapClient(
    accountName: string,
    entry: PooledImapConnection,
  ): Promise<ImapFlow> {
    const account = this.getAccount(accountName);

    const auth = await buildImapAuth(account, this.oauthService);

    const client = new ImapFlow({
      host: account.imap.host,
      port: account.imap.port,
      secure: account.imap.tls,
      tls: {
        rejectUnauthorized: account.imap.verifySsl,
      },
      auth,
      logger: false,
      disableCompression: DISABLE_COMPRESSION,
    });

    this.registerImapLifecycle(accountName, client, entry);
    await client.connect();
    await mcpLog(
      'info',
      'imap',
      `Connected to ${account.imap.host}:${account.imap.port} for "${accountName}"`,
    );
    entry.attach(client);
    return client;
  }

  // -------------------------------------------------------------------------
  // SMTP
  // -------------------------------------------------------------------------

  private static buildSmtpTransportOptions(
    account: AccountConfig,
    auth: SmtpAuth,
  ): nodemailer.TransportOptions {
    const pool = account.smtp.pool ?? {
      enabled: true,
      maxConnections: 1,
      maxMessages: 100,
    };

    return {
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.tls,
      requireTLS: account.smtp.starttls,
      ignoreTLS: !account.smtp.tls && !account.smtp.starttls,
      tls: {
        rejectUnauthorized: account.smtp.verifySsl,
      },
      auth,
      pool: pool.enabled,
      ...(pool.enabled
        ? {
            maxConnections: pool.maxConnections,
            maxMessages: pool.maxMessages,
          }
        : {}),
    } as nodemailer.TransportOptions;
  }

  async getSmtpTransport(
    accountName: string,
    options?: { verify?: boolean },
  ): Promise<Transporter> {
    const verify = options?.verify ?? false;
    const existing = this.smtpTransports.get(accountName);
    if (existing) {
      if (!verify) {
        return existing;
      }
      try {
        await existing.verify();
        return existing;
      } catch {
        this.smtpTransports.delete(accountName);
        try {
          existing.close();
        } catch {
          /* ignore */
        }
      }
    }

    const account = this.getAccount(accountName);

    // Build auth config based on auth type
    let auth: SmtpAuth;
    if (account.oauth2 && this.oauthService) {
      const accessToken = await this.oauthService.getAccessToken(account.oauth2);
      auth = { type: 'OAuth2', user: account.username, accessToken };
    } else {
      auth = { user: account.username, pass: account.password };
    }

    const transport = nodemailer.createTransport(
      ConnectionManager.buildSmtpTransportOptions(account, auth),
    );

    await transport.verify();
    await mcpLog(
      'info',
      'smtp',
      `Connected to ${account.smtp.host}:${account.smtp.port} for "${accountName}"`,
    );
    this.smtpTransports.set(accountName, transport);
    return transport;
  }

  async verifySmtpTransport(accountName: string): Promise<void> {
    await this.getSmtpTransport(accountName, { verify: true });
  }

  // -------------------------------------------------------------------------
  // Test connections (for setup wizard / test command)
  // -------------------------------------------------------------------------

  static async testImap(
    account: AccountConfig,
    oauthService?: OAuthService,
  ): Promise<{
    success: boolean;
    error?: string;
    details?: { messages: number; folders: number };
  }> {
    let client: ImapFlow | undefined;
    try {
      let auth: { user: string; pass?: string; accessToken?: string };
      if (account.oauth2 && oauthService) {
        const accessToken = await oauthService.getAccessToken(account.oauth2);
        auth = { user: account.username, accessToken };
      } else {
        auth = { user: account.username, pass: account.password };
      }

      client = new ImapFlow({
        host: account.imap.host,
        port: account.imap.port,
        secure: account.imap.tls,
        tls: {
          rejectUnauthorized: account.imap.verifySsl,
        },
        auth,
        logger: false,
      });
      client.on('error', () => {});
      await client.connect();

      const mailboxes = await client.list();
      let messageCount = 0;
      try {
        const inbox = await client.status('INBOX', {
          messages: true,
          unseen: true,
        });
        messageCount = inbox.messages ?? 0;
      } catch {
        // INBOX may not exist (e.g. Google Workspace uses "All Mail")
        if (mailboxes.length > 0) {
          try {
            const first = await client.status(mailboxes[0].path, {
              messages: true,
            });
            messageCount = first.messages ?? 0;
          } catch {
            /* ignore — connection still works */
          }
        }
      }

      return {
        success: true,
        details: {
          messages: messageCount,
          folders: mailboxes.length,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (client) {
        try {
          await client.logout();
        } catch {
          /* ignore */
        }
      }
    }
  }

  static async testSmtp(
    account: AccountConfig,
    oauthService?: OAuthService,
  ): Promise<{ success: boolean; error?: string }> {
    let transport: Transporter | undefined;
    try {
      let auth: SmtpAuth;
      if (account.oauth2 && oauthService) {
        const accessToken = await oauthService.getAccessToken(account.oauth2);
        auth = { type: 'OAuth2', user: account.username, accessToken };
      } else {
        auth = { user: account.username, pass: account.password };
      }

      transport = nodemailer.createTransport(
        ConnectionManager.buildSmtpTransportOptions(account, auth),
      );
      await transport.verify();
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      transport?.close();
    }
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  async closeAll(): Promise<void> {
    await mcpLog('info', 'connections', 'Closing all connections');
    const closeOps: Promise<void>[] = [];

    Array.from(this.imapPools.entries()).forEach(([name, pool]) => {
      pool.forEach((entry) => {
        closeOps.push(
          // A slot may still be opening; wait for it rather than leaking the
          // socket it is about to produce.
          entry.ready
            .then(async (client) => client.logout())
            .catch(() => {})
            .then(() => undefined),
        );
      });
      this.imapPools.delete(name);
    });

    Array.from(this.smtpTransports.entries()).forEach(([name, transport]) => {
      transport.close();
      this.smtpTransports.delete(name);
    });

    await Promise.allSettled(closeOps);
  }
}
