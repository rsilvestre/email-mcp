/**
 * MCP tool: list_mailboxes
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type ImapService from '../services/imap.service.js';

export default function registerMailboxesTools(server: McpServer, imapService: ImapService): void {
  server.tool(
    'list_mailboxes',
    'List all mailbox folders for an account with unread counts and special-use flags. Use list_accounts first to get the account name.',
    {
      account: z.string().describe('Account name from list_accounts'),
      include_counts: z
        .boolean()
        .optional()
        .describe(
          'Include message and unread counts. Free where the server supports LIST-STATUS and always included there. Elsewhere each folder costs a separate round trip — 6 seconds on a 309-folder account — so it is off unless requested.',
        ),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account, include_counts: includeCounts }) => {
      try {
        const mailboxes = await imapService.listMailboxes(account, { includeCounts });

        const lines = mailboxes.map((mb) => {
          const special = mb.specialUse ? ` [${mb.specialUse}]` : '';
          if (mb.totalMessages === undefined) return `• ${mb.path}${special}`;
          const badge = (mb.unseenMessages ?? 0) > 0 ? ` (${mb.unseenMessages} unread)` : '';
          return `• ${mb.path}${special} — ${mb.totalMessages} messages${badge}`;
        });

        // Say why the numbers are missing, and how to get them.
        const countsOmitted = mailboxes.length > 0 && mailboxes[0]?.totalMessages === undefined;
        if (countsOmitted) {
          lines.push(
            '',
            'Message counts omitted: this server has no LIST-STATUS, so each folder ' +
              'would need its own round trip. Pass include_counts: true if you need them.',
          );
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: lines.join('\n') || 'No mailboxes found.',
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to list mailboxes: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
