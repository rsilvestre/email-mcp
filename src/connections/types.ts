import type { ImapFlow } from 'imapflow';
import type { Transporter } from 'nodemailer';
import type { AccountConfig } from '../types/index.js';

export interface IConnectionManager {
  getAccount: (name: string) => AccountConfig;
  getAccountNames: () => string[];
  getImapClient: (accountName: string) => Promise<ImapFlow>;
  /**
   * Run one unit of IMAP work, spread across the account's connections.
   *
   * Prefer this wherever calls are issued concurrently: imapflow serialises
   * commands on a connection, so a Promise.all over getImapClient runs single
   * file. Holding the task lets the pool see when a connection frees up.
   */
  withImapClient: <T>(accountName: string, task: (client: ImapFlow) => Promise<T>) => Promise<T>;
  getSmtpTransport: (accountName: string, options?: { verify?: boolean }) => Promise<Transporter>;
  closeAll: () => Promise<void>;
}
