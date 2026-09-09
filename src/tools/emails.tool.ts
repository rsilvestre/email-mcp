/**
 * MCP tools: list_emails, get_email, get_email_security, get_emails, get_email_status, search_emails
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type ImapService from '../services/imap.service.js';
import type { Email, EmailMeta, PaginatedResult } from '../types/index.js';
import { formatBulk } from '../utils/bulk-headers.js';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatEmailMeta(email: EmailMeta): string {
  const flags = [
    email.seen ? '' : '🔵',
    email.flagged ? '⭐' : '',
    email.answered ? '↩️' : '',
    email.hasAttachments ? '📎' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const from = email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address;
  const labelStr = email.labels.length > 0 ? `\n  🏷️ ${email.labels.join(', ')}` : '';
  const bulk = formatBulk(email.bulk);
  const bulkStr = bulk ? `\n  ${bulk}` : '';
  const previewStr = email.preview ? `\n  ${email.preview}` : '';
  // A UID is meaningless without the folder it belongs to, so a result gathered
  // from several places has to name its own — otherwise nothing can act on it.
  const sourceStr = email.mailbox
    ? `\n  📍 ${email.account ? `${email.account} · ` : ''}${email.mailbox}`
    : '';

  return `[${email.id}] ${flags} ${email.subject}\n  From: ${from} | ${email.date}${sourceStr}${labelStr}${bulkStr}${previewStr}`;
}

/** Strips HTML markup and decodes common entities to produce readable plain text. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Removes quoted reply chains and signatures from plain text. */
function stripReplyChain(text: string): string {
  const lines = text.split('\n');
  const stopIdx = lines.findIndex((l) => /^--\s*$/.test(l) || /^_{3,}\s*$/.test(l));
  const relevant = stopIdx === -1 ? lines : lines.slice(0, stopIdx);
  return relevant
    .filter((l) => !l.startsWith('>'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Render a result count.
 *
 * A filter IMAP cannot express is resolved by inspecting messages until the
 * page is full, so the count reflects what was examined rather than the whole
 * match set. Printing that as an exact number would be a plain lie, and so
 * would the page count derived from it.
 */
function formatResultCount(result: {
  total: number;
  page: number;
  pageSize: number;
  totalIsLowerBound?: boolean;
}): string {
  const pageCount = Math.max(1, Math.ceil(result.total / result.pageSize));
  return result.totalIsLowerBound
    ? `${result.total}+ (page ${result.page})`
    : `${result.total} (page ${result.page}/${pageCount})`;
}

type BodyFormat = 'full' | 'text' | 'stripped';

/**
 * Applies the requested body format and optional character cap.
 *
 * - full:     raw bodyText ?? bodyHtml (preserves original, default)
 * - text:     prefers bodyText; converts bodyHtml to plain text if needed
 * - stripped: like text, but also removes quoted reply chains and signatures
 */
function applyBodyFormat(
  bodyText: string | undefined,
  bodyHtml: string | undefined,
  format: BodyFormat,
  maxLength?: number,
): string {
  let body: string;

  if (format === 'full') {
    body = bodyText ?? bodyHtml ?? '(no content)';
  } else {
    const base = bodyText ?? (bodyHtml ? stripHtml(bodyHtml) : undefined) ?? '(no content)';
    body = format === 'stripped' ? stripReplyChain(base) : base;
  }

  if (maxLength !== undefined && maxLength > 0 && body.length > maxLength) {
    const remaining = body.length - maxLength;
    body = `${body.slice(0, maxLength)}\n\n… (${remaining} more characters — increase maxLength to read the full body)`;
  }

  return body;
}

/** Renders the current read/flag/label state as a concise status line. */
function formatEmailStatus(email: Pick<Email, 'seen' | 'flagged' | 'answered' | 'labels'>): string {
  const parts: string[] = [email.seen ? '✓ Read' : '🔵 Unread'];
  if (email.flagged) parts.push('⭐ Flagged');
  if (email.answered) parts.push('↩️ Replied');
  const labelStr = email.labels.length > 0 ? ` · 🏷️ ${email.labels.join(', ')}` : '';
  return `${parts.join(' · ')}${labelStr}`;
}

// ---------------------------------------------------------------------------

export default function registerEmailsTools(server: McpServer, imapService: ImapService): void {
  // ---------------------------------------------------------------------------
  // list_emails
  // ---------------------------------------------------------------------------
  server.tool(
    'list_emails',
    'List emails in a mailbox with optional filters. Returns paginated results with metadata ' +
      '(read/unread 🔵, flagged ⭐, replied ↩️, attachments 📎, labels 🏷️). ' +
      'List or machine-generated mail is marked 📰 newsletter / 🤖 automated from its RFC headers, with the unsubscribe URI when the sender offers one — personal mail carries no marker. ' +
      'Use get_email to fetch full body content. ' +
      'ProtonMail note: labels are represented as IMAP folders — use list_labels to discover them, ' +
      'then list_emails with mailbox="Labels/X" to find labeled emails.',
    {
      account: z.string().describe('Account name from list_accounts'),
      mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
      page: z.coerce.number().int().min(1).default(1).describe('Page number'),
      pageSize: z.coerce.number().int().min(1).max(100).default(20).describe('Results per page'),
      since: z.string().optional().describe('Show emails after this date (ISO 8601)'),
      before: z.string().optional().describe('Show emails before this date (ISO 8601)'),
      from: z.string().optional().describe('Filter by sender address or name'),
      subject: z.string().optional().describe('Filter by subject keyword'),
      seen: z.boolean().optional().describe('Filter: true=read only, false=unread only'),
      flagged: z.boolean().optional().describe('Filter: true=flagged only, false=unflagged only'),
      has_attachment: z
        .boolean()
        .optional()
        .describe('Filter: true=has attachments, false=no attachments'),
      answered: z.boolean().optional().describe('Filter: true=replied, false=not yet replied'),
      preview: z
        .boolean()
        .default(false)
        .describe(
          'Include a ~200 character body preview per message. Off by default: it fetches extra bytes per message and lengthens the output.',
        ),
    },
    { readOnlyHint: true, destructiveHint: false },
    async (params) => {
      try {
        const result = await imapService.listEmails(params.account, {
          mailbox: params.mailbox,
          page: params.page,
          pageSize: params.pageSize,
          since: params.since,
          before: params.before,
          from: params.from,
          subject: params.subject,
          seen: params.seen,
          flagged: params.flagged,
          hasAttachment: params.has_attachment,
          answered: params.answered,
          preview: params.preview,
        });

        if (result.items.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No emails found matching the criteria.' }],
          };
        }

        const header =
          `📬 [${params.mailbox}] ${formatResultCount(result)} emails` +
          `${result.hasMore ? ' — more pages available' : ''}\n`;
        const emails = result.items.map(formatEmailMeta).join('\n\n');

        return {
          content: [{ type: 'text' as const, text: `${header}\n${emails}` }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to list emails: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // get_email_security
  // ---------------------------------------------------------------------------
  server.tool(
    'get_email_security',
    'Get read-only sender-authentication signals for an email without returning the raw header block or body. ' +
      'Reports SPF, DKIM, DMARC, sender-related domains, DKIM signing domains, and List-Unsubscribe presence. ' +
      'Does not mark the email as seen. Missing authentication results are reported as unavailable, not as failure.',
    {
      account: z.string().describe('Account name from list_accounts'),
      emailId: z.string().describe('Email ID from list_emails or search_emails'),
      mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account, emailId, mailbox }) => {
      try {
        const security = await imapService.getEmailSecurity(account, emailId, mailbox);
        function renderStatuses(values: string[]): string {
          return values.length > 0 ? values.join(', ') : 'not reported';
        }

        const parts = [
          '🔐 Email security signals',
          `From domain:        ${security.fromDomain ?? 'not available'}`,
          `Return-Path domain: ${security.returnPathDomain ?? 'not available'}`,
          `Reply-To domain:    ${security.replyToDomain ?? 'not available'}`,
          `SPF:                ${renderStatuses(security.spf)}`,
          `DKIM:               ${renderStatuses(security.dkim)}`,
          `DMARC:              ${renderStatuses(security.dmarc)}`,
          `DKIM domains:       ${security.dkimDomains.length > 0 ? security.dkimDomains.join(', ') : 'not reported'}`,
          `Authentication-Results: ${security.authenticationResultsPresent ? 'present' : 'not present'}`,
          `List-Unsubscribe:       ${security.listUnsubscribe ? 'present' : 'not present'}`,
          '',
          'Note: these are signals supplied by the receiving mail system; absence alone is not an authentication failure.',
        ];

        return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to get email security signals: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // get_email
  // ---------------------------------------------------------------------------
  server.tool(
    'get_email',
    'Get the full content of a specific email by ID. ' +
      'Does NOT mark the email as seen (uses IMAP BODY.PEEK — non-destructive). ' +
      'Use format="text" to strip HTML, or format="stripped" to also remove quoted replies and signatures. ' +
      'Use maxLength to cap the body size for large emails. ' +
      'Set markRead=true only when you want to explicitly mark the email as read. ' +
      'A Bulk: line appears for list or machine-generated mail (📰 newsletter / 🤖 automated), ' +
      'derived from RFC headers, with the unsubscribe URI when the sender offers one.',
    {
      account: z.string().describe('Account name from list_accounts'),
      emailId: z.string().describe('Email ID from list_emails or search_emails'),
      mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
      format: z
        .enum(['full', 'text', 'stripped'])
        .default('full')
        .describe(
          'Body format: full=raw (default), text=plain text (strips HTML), stripped=plain text without quoted replies or signatures',
        ),
      maxLength: z.coerce
        .number()
        .int()
        .min(100)
        .optional()
        .describe(
          'Truncate body at this many characters. A hint shows how many characters remain.',
        ),
      markRead: z
        .boolean()
        .default(false)
        .describe(
          'Explicitly mark the email as read after fetching (default: false — reading is non-destructive by default)',
        ),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account, emailId, mailbox, format, maxLength, markRead }) => {
      try {
        const email = await imapService.getEmail(account, emailId, mailbox);

        const parts: string[] = [
          `📧 ${email.subject}`,
          `Status: ${formatEmailStatus(email)}`,
          `From:   ${email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address}`,
          `To:     ${email.to.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ')}`,
        ];

        if (email.cc?.length) {
          parts.push(`CC:     ${email.cc.map((a) => a.address).join(', ')}`);
        }

        parts.push(`Date:   ${email.date}`);
        parts.push(`ID:     ${email.messageId}`);

        const bulk = formatBulk(email.bulk);
        if (bulk) {
          parts.push(`Bulk:   ${bulk}`);
        }

        if (email.inReplyTo) {
          parts.push(`Reply:  ${email.inReplyTo}`);
        }

        if (email.attachments.length > 0) {
          parts.push(
            `📎 Attachments: ${email.attachments.map((a) => `${a.filename} (${a.mimeType}, ${formatSize(a.size)})`).join(', ')}`,
          );
        }

        parts.push('', '--- Body ---', '');
        parts.push(
          applyBodyFormat(email.bodyText, email.bodyHtml, format as BodyFormat, maxLength),
        );

        if (markRead) {
          await imapService.setFlags(account, emailId, mailbox, 'read');
        }

        return {
          content: [{ type: 'text' as const, text: parts.join('\n') }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to get email: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // get_emails  (batch content fetch)
  // ---------------------------------------------------------------------------
  server.tool(
    'get_emails',
    'Fetch the full content of multiple emails in a single call (max 20). ' +
      'More efficient than calling get_email repeatedly when triaging or summarising several emails. ' +
      'Does NOT mark emails as seen. ' +
      'Defaults to format="text" (HTML stripped) for compact, AI-friendly output. ' +
      'Each message carries the same 📰 newsletter / 🤖 automated marker as get_email.',
    {
      account: z.string().describe('Account name from list_accounts'),
      ids: z
        .array(z.string())
        .min(1)
        .max(20)
        .describe('Email IDs to fetch (max 20). Obtain IDs from list_emails or search_emails.'),
      mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
      format: z
        .enum(['full', 'text', 'stripped'])
        .default('text')
        .describe(
          'Body format (default: text — strips HTML for efficient AI reading). Use stripped to also remove quoted replies.',
        ),
      maxLength: z.coerce
        .number()
        .int()
        .min(100)
        .optional()
        .describe('Truncate each email body at this many characters.'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account, ids, mailbox, format, maxLength }) => {
      const results: string[] = [];
      const errors: string[] = [];

      const settled = await Promise.allSettled(
        ids.map(async (emailId) => imapService.getEmail(account, emailId, mailbox)),
      );

      settled.forEach((outcome, i) => {
        const emailId = ids[i];
        if (outcome.status === 'fulfilled') {
          const email = outcome.value;
          const from = email.from.name
            ? `${email.from.name} <${email.from.address}>`
            : email.from.address;
          const body = applyBodyFormat(
            email.bodyText,
            email.bodyHtml,
            format as BodyFormat,
            maxLength,
          );
          const attachLine =
            email.attachments.length > 0
              ? `📎 ${email.attachments.map((a) => a.filename).join(', ')}`
              : '';
          const bulkLine = formatBulk(email.bulk);

          results.push(
            [
              `━━━ [${emailId}] ${email.subject}`,
              `Status: ${formatEmailStatus(email)}`,
              `From:   ${from}`,
              `Date:   ${email.date}`,
              bulkLine ? `Bulk:   ${bulkLine}` : '',
              attachLine,
              '',
              body,
            ]
              .filter((l) => l !== '')
              .join('\n'),
          );
        } else {
          const err = outcome.reason as unknown;
          errors.push(`[${emailId}] Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

      const errSuffix = errors.length > 0 ? `, ${errors.length} error(s)` : '';
      const summary = `📬 [${mailbox}] ${results.length} email(s) fetched${errSuffix}`;

      const parts: string[] = [summary, '', ...results];
      if (errors.length > 0) {
        parts.push('', '--- Errors ---', ...errors);
      }

      return {
        content: [{ type: 'text' as const, text: parts.join('\n') }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // get_email_status  (lightweight flag/label check — no body fetch)
  // ---------------------------------------------------------------------------
  server.tool(
    'get_email_status',
    'Get the current read/flag/label state of an email without fetching its body. ' +
      'Much cheaper than get_email when you only need to check whether an email is unread, ' +
      'flagged, or which labels it has. ' +
      'Also useful to confirm the result of a mark_email call. ' +
      'Does NOT mark the email as seen.',
    {
      account: z.string().describe('Account name from list_accounts'),
      emailId: z.string().describe('Email ID from list_emails or search_emails'),
      mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account, emailId, mailbox }) => {
      try {
        const flags = await imapService.getEmailFlags(account, emailId, mailbox);

        const statusParts: string[] = [flags.seen ? '✓ Read' : '🔵 Unread'];
        if (flags.flagged) statusParts.push('⭐ Flagged');
        if (flags.answered) statusParts.push('↩️ Replied');

        const lines = [
          `📊 Email Status`,
          `ID:      ${emailId} | Mailbox: ${mailbox}`,
          `Subject: ${flags.subject}`,
          `From:    ${flags.from}`,
          `Date:    ${flags.date}`,
          `Status:  ${statusParts.join(' · ')}`,
          `Labels:  ${flags.labels.length > 0 ? flags.labels.join(', ') : '(none)'}`,
        ];

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to get email status: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // search_emails
  // ---------------------------------------------------------------------------
  server.tool(
    'search_emails',
    'Search emails by keyword across subject, sender, and body. ' +
      'Omit query (or pass an empty string) to use it as a pure filter — e.g. find all emails ' +
      'with attachments from a specific recipient without a keyword. ' +
      'Supports additional filters for recipient, attachments, size, and reply status. ' +
      'Use scope to widen beyond one folder: "account" searches every folder of the account, ' +
      '"all_accounts" searches them all. Widened results show 📍 the account and folder each ' +
      'message was found in — pass that folder as mailbox to any follow-up tool. ' +
      'Results carry the same 📰 newsletter / 🤖 automated markers as list_emails.',
    {
      account: z
        .string()
        .optional()
        .describe('Account name from list_accounts. Required unless scope is "all_accounts"'),
      query: z
        .string()
        .optional()
        .default('')
        .describe('Search keyword (omit or leave empty to use filters only)'),
      scope: z
        .enum(['mailbox', 'account', 'all_accounts'])
        .default('mailbox')
        .describe(
          'How wide to search: one mailbox (default), every folder of the account, or every account',
        ),
      mailbox: z
        .string()
        .default('INBOX')
        .describe('Mailbox path (default: INBOX). Ignored unless scope is "mailbox"'),
      page: z.coerce.number().int().min(1).default(1).describe('Page number'),
      pageSize: z.coerce.number().int().min(1).max(100).default(20).describe('Results per page'),
      to: z.string().optional().describe('Filter by recipient address'),
      has_attachment: z
        .boolean()
        .optional()
        .describe('Filter: true=has attachments, false=no attachments'),
      larger_than: z.coerce.number().optional().describe('Minimum email size in KB'),
      smaller_than: z.coerce.number().optional().describe('Maximum email size in KB'),
      answered: z.boolean().optional().describe('Filter: true=replied, false=not replied'),
      search_body: z
        .boolean()
        .optional()
        .describe(
          'Search message bodies as well as subjects and senders. On by default. This is the expensive half on a server with no full-text index, which scans every message: a 1611-message folder measured 6.7s with bodies against about 0.3s without. Set false for a fast search when the subject or sender is enough.',
        ),
      preview: z
        .boolean()
        .default(false)
        .describe(
          'Include a ~200 character body preview per message. Off by default: it fetches extra bytes per message and lengthens the output.',
        ),
    },
    { readOnlyHint: true, destructiveHint: false },
    async (params) => {
      try {
        const wideOptions = {
          page: params.page,
          pageSize: params.pageSize,
          to: params.to,
          largerThan: params.larger_than,
          smallerThan: params.smaller_than,
          answered: params.answered,
          preview: params.preview,
        };

        let result: PaginatedResult<EmailMeta>;
        if (params.scope === 'mailbox') {
          if (!params.account) {
            throw new Error('account is required unless scope is "all_accounts"');
          }
          result = await imapService.searchEmails(params.account, params.query ?? '', {
            ...wideOptions,
            mailbox: params.mailbox,
            hasAttachment: params.has_attachment,
            searchBody: params.search_body,
          });
        } else if (params.scope === 'all_accounts') {
          result = await imapService.searchAcross('all', params.query ?? '', wideOptions);
        } else {
          if (!params.account) {
            throw new Error('account is required unless scope is "all_accounts"');
          }
          result = await imapService.searchAcross(
            [params.account],
            params.query ?? '',
            wideOptions,
          );
        }

        if (result.items.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: params.query
                  ? `No emails found matching "${params.query}".`
                  : 'No emails found matching the specified filters.',
              },
            ],
          };
        }

        const queryLabel = params.query ? `"${params.query}"` : 'filters';
        const where =
          params.scope === 'mailbox' ? params.mailbox : `scope: ${params.scope.replace('_', ' ')}`;
        // Naming what did not finish matters more than the count: without it a
        // partial answer is indistinguishable from an empty one.
        const skipped = result.incompleteSources ?? [];
        const andMore = skipped.length > 5 ? ` and ${skipped.length - 5} more` : '';
        const partial =
          skipped.length > 0
            ? `\n⚠️ Incomplete — these did not finish in time and were skipped: ${skipped
                .slice(0, 5)
                .join(', ')}${andMore}. Narrow the scope, or search those folders directly.`
            : '';
        const noBody = result.bodyNotSearched ?? [];
        const headersOnly =
          noBody.length > 0
            ? `\nℹ️ Only subjects, senders and recipients were searched in these folders, which are large enough that scanning their bodies would have cost more than the rest of the search put together: ${noBody
                .slice(0, 5)
                .join(
                  ', ',
                )}${noBody.length > 5 ? ` and ${noBody.length - 5} more` : ''}. Message bodies were searched everywhere else. Use scope "mailbox" on one of these to search its bodies.`
            : '';
        const header =
          `🔍 [${where}] ${formatResultCount(result)} result(s) for ${queryLabel}` +
          `${result.hasMore ? ' — more pages available' : ''}${partial}${headersOnly}\n`;
        const emails = result.items.map(formatEmailMeta).join('\n\n');

        return {
          content: [{ type: 'text' as const, text: `${header}\n${emails}` }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to search emails: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
