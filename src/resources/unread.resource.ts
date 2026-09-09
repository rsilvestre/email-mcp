/**
 * MCP Resource: email://{account}/unread
 *
 * Dynamic resource providing an unread email summary per folder.
 * Only includes folders with unread messages.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

import type ConnectionManager from '../connections/manager.js';
import type ImapService from '../services/imap.service.js';

export default function registerUnreadResource(
  server: McpServer,
  connections: ConnectionManager,
  imapService: ImapService,
): void {
  const names = connections.getAccountNames();
  const accounts = names.map((name) => connections.getAccount(name));

  server.resource(
    'unread',
    new ResourceTemplate('email://{account}/unread', {
      list: async () => ({
        resources: accounts.map((a) => ({
          uri: `email://${a.name}/unread`,
          name: `${a.name} — Unread summary`,
          description: `Unread email counts by folder for ${a.email}`,
          mimeType: 'application/json',
        })),
      }),
    }),
    { description: 'Unread email count summary by folder for an account' },
    async (uri, { account }) => {
      const accountName = account as string;
      // This resource is the counts, so it asks for them even where that means
      // a STATUS per folder.
      const mailboxes = await imapService.listMailboxes(accountName, { includeCounts: true });

      const unreadFolders = mailboxes
        .filter((mb) => (mb.unseenMessages ?? 0) > 0)
        .map((mb) => ({
          path: mb.path,
          unread: mb.unseenMessages ?? 0,
        }));

      const totalUnread = unreadFolders.reduce((sum, f) => sum + f.unread, 0);

      const summary = {
        account: accountName,
        totalUnread,
        folders: unreadFolders,
      };

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    },
  );
}
