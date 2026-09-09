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
import type { IConnectionManager } from './types.js';

type SmtpAuth =
  | { user: string; pass?: string }
  | { type: string; user: string; accessToken: string };

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

export default class ConnectionManager implements IConnectionManager {
  private imapClients = new Map<string, ImapFlow>();

  /** Connections currently being opened, so concurrent callers join one attempt. */
  private imapClientsConnecting = new Map<string, Promise<ImapFlow>>();

  /** When each pooled IMAP connection was last handed out, for idle probing. */
  private imapClientsLastUsedAt = new Map<string, number>();

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

  private registerImapLifecycle(accountName: string, client: ImapFlow): void {
    const invalidateIfCurrent = () => {
      if (this.imapClients.get(accountName) === client) {
        this.imapClients.delete(accountName);
        this.imapClientsLastUsedAt.delete(accountName);
      }
    };

    client.on('error', (err) => {
      invalidateIfCurrent();
      mcpLog(
        'error',
        'imap',
        `Connection error for "${accountName}": ${err instanceof Error ? err.message : String(err)}`,
      ).catch(() => undefined);
    });

    client.on('close', invalidateIfCurrent);
  }

  /**
   * Has this connection been idle long enough that it might have been dropped
   * without us hearing about it?
   */
  private hasBeenIdleTooLong(accountName: string): boolean {
    if (IDLE_BEFORE_PROBE_MS <= 0) return false;
    const lastUsedAt = this.imapClientsLastUsedAt.get(accountName);
    return lastUsedAt === undefined || Date.now() - lastUsedAt > IDLE_BEFORE_PROBE_MS;
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

  async getImapClient(accountName: string): Promise<ImapFlow> {
    const existing = this.imapClients.get(accountName);
    if (existing?.usable && !this.hasBeenIdleTooLong(accountName)) {
      this.imapClientsLastUsedAt.set(accountName, Date.now());
      return existing;
    }

    // A connection for this account may already be opening. Join that attempt
    // instead of starting a second one: without this, concurrent first calls
    // (get_emails fanning out over ids, check_health over accounts) each build
    // an ImapFlow and call connect(), and only the last one written to the map
    // is ever reachable — the others stay open, unreferenced, and are never
    // logged out. Mirrors the labelStrategyPending pattern in ImapService.
    const connecting = this.imapClientsConnecting.get(accountName);
    if (connecting) {
      return connecting;
    }

    const attempt = this.reviveOrOpenImapClient(accountName, existing);
    this.imapClientsConnecting.set(accountName, attempt);
    try {
      return await attempt;
    } finally {
      // Cleared on failure too, so the next call retries rather than joining a
      // promise that has already rejected.
      this.imapClientsConnecting.delete(accountName);
    }
  }

  /**
   * Reuse an idle connection if it still answers, otherwise build a new one.
   *
   * Runs inside the in-flight guard, so racing callers share one probe rather
   * than each sending their own NOOP.
   */
  private async reviveOrOpenImapClient(
    accountName: string,
    existing?: ImapFlow,
  ): Promise<ImapFlow> {
    if (existing?.usable) {
      if (await ConnectionManager.respondsToProbe(existing)) {
        this.imapClientsLastUsedAt.set(accountName, Date.now());
        return existing;
      }
      await mcpLog(
        'info',
        'imap',
        `Idle connection for "${accountName}" did not answer; reconnecting`,
      );
    }

    return this.openImapClient(accountName, existing);
  }

  /** Build, connect and cache a fresh IMAP client, discarding any stale one. */
  private async openImapClient(accountName: string, staleClient?: ImapFlow): Promise<ImapFlow> {
    if (staleClient) {
      this.imapClients.delete(accountName);
      try {
        staleClient.close();
      } catch {
        /* ignore */
      }
    }

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

    this.registerImapLifecycle(accountName, client);
    await client.connect();
    await mcpLog(
      'info',
      'imap',
      `Connected to ${account.imap.host}:${account.imap.port} for "${accountName}"`,
    );
    this.imapClients.set(accountName, client);
    this.imapClientsLastUsedAt.set(accountName, Date.now());
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

    Array.from(this.imapClients.entries()).forEach(([name, client]) => {
      closeOps.push(
        client
          .logout()
          .catch(() => {})
          .then(() => {
            this.imapClients.delete(name);
            this.imapClientsLastUsedAt.delete(name);
          }),
      );
    });

    Array.from(this.smtpTransports.entries()).forEach(([name, transport]) => {
      transport.close();
      this.smtpTransports.delete(name);
    });

    await Promise.allSettled(closeOps);
  }
}
