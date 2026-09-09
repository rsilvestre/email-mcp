/**
 * IMAP service — pure business logic for email read operations.
 *
 * No MCP dependency — fully unit-testable.
 */

import type { ImapFlow } from 'imapflow';
import type { IConnectionManager } from '../connections/types.js';
import {
  sanitizeMailboxName,
  sanitizeSearchQuery,
  validateAttachments,
} from '../safety/validation.js';
import type {
  AccountConfig,
  AttachmentInput,
  AttachmentMeta,
  BulkResult,
  Contact,
  DailyVolume,
  Email,
  EmailAddress,
  EmailMeta,
  EmailSecurityInfo,
  EmailStats,
  LabelInfo,
  Mailbox,
  MailboxSnapshot,
  PaginatedResult,
  QuotaInfo,
  SenderStat,
} from '../types/index.js';
import type { BodyTextParts, PreviewPart } from '../utils/body-preview.js';
import {
  buildPreview,
  decodeCharset,
  decodeTransferEncoding,
  findBodyTextParts,
  findPreviewPart,
  PREVIEW_PART_BYTES,
} from '../utils/body-preview.js';
import { BULK_HEADER_FIELDS, classifyBulk, parseHeaderBlock } from '../utils/bulk-headers.js';
import { buildRawMessage, resolveAttachments } from '../utils/mail-attachments.js';
import type { LabelStrategy } from './label-strategy.js';
import { detectLabelStrategy } from './label-strategy.js';

// ---------------------------------------------------------------------------
// Helpers (must be defined before ImapService)
// ---------------------------------------------------------------------------

function parseAddress(addr: { name?: string; address?: string } | undefined): EmailAddress {
  return {
    name: addr?.name ?? undefined,
    address: addr?.address ?? 'unknown',
  };
}

function parseAddresses(addrs: { name?: string; address?: string }[] | undefined): EmailAddress[] {
  if (!addrs) return [];
  return addrs.map(parseAddress);
}

function addressDomain(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const angle = /<\s*([^<>\s]+@[^<>\s]+)\s*>/.exec(value);
  const plain = /([A-Z0-9._%+-]+@([A-Z0-9.-]+))/i.exec(angle?.[1] ?? value);
  return plain?.[2]?.replace(/[>;,]+$/, '').toLowerCase();
}

function authStatuses(value: string | undefined, method: 'spf' | 'dkim' | 'dmarc'): string[] {
  if (!value) return [];
  const pattern = new RegExp(`(?:^|[;\\s])${method}\\s*=\\s*([a-z][a-z0-9_-]*)`, 'gi');
  return [...new Set([...value.matchAll(pattern)].map((match) => match[1].toLowerCase()))];
}

/** Domains that signed the message, from both the DKIM header and the verifier's report. */
function dkimSigningDomains(authenticationResults: string, dkimSignature: string): string[] {
  const clean = (value: string) => value.replace(/[<>;,]+$/g, '').toLowerCase();
  const fromResults = [...authenticationResults.matchAll(/\bheader\.d\s*=\s*([^;\s]+)/gi)];
  const fromSignature = [...dkimSignature.matchAll(/(?:^|;)\s*d\s*=\s*([^;\s]+)/gi)];

  return [...new Set([...fromResults, ...fromSignature].map((match) => clean(match[1])))];
}

/**
 * Whether this account should APPEND its own copy of outgoing mail.
 *
 * Gmail files messages sent through its SMTP into Sent Mail itself, so an
 * APPEND on top of that leaves the user with every sent message twice. Its
 * IMAP server is identifiable by the X-GM-EXT-1 capability, which is a more
 * reliable signal than matching on the hostname.
 *
 * `save_to_sent` overrides the guess in either direction.
 */
function shouldFileSentCopy(account: AccountConfig, client: ImapFlow): boolean {
  if (account.saveToSent !== undefined) {
    return account.saveToSent;
  }
  return !client.capabilities.has('X-GM-EXT-1');
}

function hasAttachments(bodyStructure: unknown): boolean {
  if (!bodyStructure || typeof bodyStructure !== 'object') return false;
  const bs = bodyStructure as Record<string, unknown>;
  if (bs.disposition === 'attachment') return true;
  if (Array.isArray(bs.childNodes)) {
    return bs.childNodes.some((child: unknown) => hasAttachments(child));
  }
  return false;
}

function extractAttachments(bodyStructure: unknown): AttachmentMeta[] {
  const attachments: AttachmentMeta[] = [];
  if (!bodyStructure || typeof bodyStructure !== 'object') return attachments;

  const bs = bodyStructure as Record<string, unknown>;
  if (bs.disposition === 'attachment') {
    const params = (bs.dispositionParameters ?? bs.parameters ?? {}) as Record<string, string>;
    attachments.push({
      filename: params.filename ?? params.name ?? 'unnamed',
      mimeType: `${bs.type ?? 'application'}/${bs.subtype ?? 'octet-stream'}`,
      size: (bs.size as number) ?? 0,
    });
  }

  if (Array.isArray(bs.childNodes)) {
    (bs.childNodes as unknown[]).forEach((child) => {
      attachments.push(...extractAttachments(child));
    });
  }

  return attachments;
}

/** Find the MIME part number for an attachment by filename. */
function findMimePartByFilename(
  bodyStructure: unknown,
  targetFilename: string,
  partPath = '',
): string | undefined {
  if (!bodyStructure || typeof bodyStructure !== 'object') return undefined;

  const bs = bodyStructure as Record<string, unknown>;
  const currentPart = bs.part as string | undefined;
  const effectivePath = currentPart ?? partPath;

  if (bs.disposition === 'attachment') {
    const params = (bs.dispositionParameters ?? bs.parameters ?? {}) as Record<string, string>;
    const filename = params.filename ?? params.name ?? 'unnamed';
    if (filename === targetFilename) return effectivePath;
  }

  if (Array.isArray(bs.childNodes)) {
    // eslint-disable-next-line no-plusplus
    for (let i = 0; i < bs.childNodes.length; i++) {
      const childPart = effectivePath ? `${effectivePath}.${i + 1}` : String(i + 1);
      const found = findMimePartByFilename(bs.childNodes[i], targetFilename, childPart);
      if (found) return found;
    }
  }

  return undefined;
}

/** Decode the preview from an already-fetched body part, when one is present. */
function previewFromMessage(msg: Record<string, unknown>): string | undefined {
  const parts = msg.bodyParts as Map<string, Buffer> | undefined;
  if (!parts) {
    return undefined;
  }
  const part = findPreviewPart(msg.bodyStructure);
  const raw = part ? parts.get(part.key) : undefined;
  return part && raw ? buildPreview(raw, part) : undefined;
}

/**
 * Fill in previews for the messages whose text sits at section 1.1.
 *
 * This needs its own fetch restricted to those UIDs: asking for a section a
 * message does not have fails the entire batch on Gmail, so 1.1 cannot simply
 * be added to the first request.
 */
async function fetchNestedPreviews(
  client: ImapFlow,
  messages: Record<string, unknown>[],
): Promise<void> {
  const byUid = new Map<number, Record<string, unknown>>();
  messages.forEach((msg) => {
    if (findPreviewPart(msg.bodyStructure)?.key === '1.1') {
      byUid.set(msg.uid as number, msg);
    }
  });
  if (byUid.size === 0) {
    return;
  }

  // eslint-disable-next-line no-restricted-syntax
  for await (const msg of client.fetch(
    [...byUid.keys()].join(','),
    { uid: true, bodyParts: [{ key: '1.1', start: 0, maxLength: PREVIEW_PART_BYTES }] },
    { uid: true },
  )) {
    const target = byUid.get(msg.uid);
    if (target) {
      target.bodyParts = msg.bodyParts;
    }
  }
}

function messageToEmailMeta(msg: Record<string, unknown>): EmailMeta {
  const envelope = (msg.envelope ?? {}) as Record<string, unknown>;
  const flags = new Set((msg.flags ?? []) as string[]);

  // Extract non-system flags as labels (IMAP keywords)
  const labels = [...flags].filter((f) => !f.startsWith('\\'));

  // BODY.PEEK[HEADER.FIELDS (...)] comes back as a raw buffer.
  const bulk =
    msg.headers && Buffer.isBuffer(msg.headers)
      ? classifyBulk(parseHeaderBlock(msg.headers.toString('utf-8')))
      : undefined;

  return {
    id: String(msg.uid ?? msg.seq),
    subject: (envelope.subject as string) ?? '(no subject)',
    from: parseAddress((envelope.from as Record<string, string>[])?.[0]),
    to: parseAddresses(envelope.to as Record<string, string>[]),
    date: envelope.date
      ? new Date(envelope.date as string).toISOString()
      : new Date().toISOString(),
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    hasAttachments: hasAttachments(msg.bodyStructure),
    labels,
    bulk,
    preview: previewFromMessage(msg),
  };
}

/**
 * Read one text part off the wire and decode it.
 *
 * Returns undefined rather than throwing: a structure can name a section the
 * server then refuses, and a message with an unreadable body is still worth
 * returning with its headers intact.
 */
/**
 * Most matches pulled from any one folder when merging results.
 *
 * A cross-folder search has to sort by date across sources, which needs each
 * candidate's envelope. Without a ceiling, a broad query on a large mailbox
 * would fetch envelopes for everything it matched just to show twenty rows.
 */
const MAX_CANDIDATES_PER_SOURCE = 200;

/**
 * How long a search spanning several folders may run before returning what it
 * has.
 *
 * A server that indexes its mail answers whatever the folder count: Gmail
 * returns in well under a second across 147 labels, because All Mail is one
 * search. A server without an index is linear in folders and in message size —
 * an account measured here with 309 folders took 77 seconds for the same
 * query. Waiting that long is worse than a partial answer that says so.
 */
const CROSS_FOLDER_DEADLINE_MS = Number(process.env.MCP_EMAIL_SEARCH_DEADLINE_MS ?? 15_000);

/**
 * Folder size up to which searching message bodies is affordable on a server
 * with no full-text index.
 *
 * Measured against one such account: a body search costs 276 ms on a folder of
 * twenty messages against 262 ms for headers alone — the round trip dominates,
 * the scan is free. The same search costs 4223 ms on a folder of several
 * hundred. So the body term is worth including almost everywhere, and worth
 * dropping only on the handful of large folders.
 *
 * The size comes from the SELECT the search performs anyway, so deciding this
 * per folder costs nothing.
 */
const BODY_SEARCH_MAX_MESSAGES = 50;

/** Counters asked of every folder when listing mailboxes. */
const MAILBOX_STATUS_FIELDS = { messages: true, unseen: true } as const;

/**
 * First batch of UIDs examined when a filter has to be applied client-side.
 *
 * Batches grow geometrically from here. A fixed size gets the dense case right
 * and the sparse case wrong: where matches are rare, filling one page of twenty
 * took eight round trips, which measured slower than the whole-set fetch it
 * replaced even though it moved fewer bytes.
 */
const ATTACHMENT_FILTER_FIRST_BATCH = 250;

/** How much larger each subsequent batch is, once the first proves too small. */
const ATTACHMENT_FILTER_GROWTH = 4;

/** Ceiling on a single batch, so one fetch cannot name an unbounded UID list. */
const ATTACHMENT_FILTER_MAX_BATCH = 4000;

interface FilteredPage {
  pageUids: number[];
  /** Matches confirmed so far — a lower bound unless the scan ran to the end. */
  total: number;
  hasMore: boolean;
  totalIsLowerBound: boolean;
}

/**
 * Page through a UID set under the hasAttachment filter.
 *
 * IMAP cannot search on the presence of an attachment, so the structure of
 * each candidate has to be fetched and inspected. Doing that for the entire
 * match set before paginating meant a BODYSTRUCTURE fetch of the whole mailbox
 * to return twenty rows.
 *
 * Instead the sorted UIDs are examined in batches and the scan stops once the
 * page is full. The cost of `total` is what changes: it now counts only what
 * was examined, and the caller is told so rather than being handed a number
 * that looks exact.
 */
async function selectPageWithAttachmentFilter(
  client: ImapFlow,
  sortedUids: number[],
  wantsAttachment: boolean,
  skipCount: number,
  pageSize: number,
): Promise<FilteredPage> {
  // One past the page tells us whether anything follows it.
  const needed = skipCount + pageSize + 1;
  const matches: number[] = [];
  let examinedAll = true;
  let batchSize = ATTACHMENT_FILTER_FIRST_BATCH;
  let offset = 0;

  while (offset < sortedUids.length) {
    if (matches.length >= needed) {
      examinedAll = false;
      break;
    }

    const batch = sortedUids.slice(offset, offset + batchSize);
    // Advance by what this batch actually covered, then widen the next look.
    // Growing before advancing would step over the UIDs in between and drop
    // them from the results entirely.
    offset += batch.length;
    batchSize = Math.min(batchSize * ATTACHMENT_FILTER_GROWTH, ATTACHMENT_FILTER_MAX_BATCH);
    const structureByUid = new Map<number, unknown>();
    // eslint-disable-next-line no-restricted-syntax, no-await-in-loop
    for await (const msg of client.fetch(
      batch.join(','),
      { uid: true, bodyStructure: true },
      { uid: true },
    )) {
      const raw = msg as unknown as Record<string, unknown>;
      structureByUid.set(raw.uid as number, raw.bodyStructure);
    }

    // Iterate the batch, not the fetch, so ordering is the sorted one.
    batch.forEach((uid) => {
      if (hasAttachments(structureByUid.get(uid)) === wantsAttachment) {
        matches.push(uid);
      }
    });
  }

  return {
    pageUids: matches.slice(skipCount, skipCount + pageSize),
    total: matches.length,
    hasMore: matches.length > skipCount + pageSize,
    totalIsLowerBound: !examinedAll,
  };
}

async function downloadTextPart(
  client: ImapFlow,
  uid: number,
  part: PreviewPart,
): Promise<string | undefined> {
  try {
    const downloaded = await client.download(String(uid), part.key, { uid: true });
    if (!downloaded?.content) return undefined;

    const chunks: Buffer[] = [];
    // eslint-disable-next-line no-restricted-syntax
    for await (const chunk of downloaded.content) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return decodeCharset(
      decodeTransferEncoding(Buffer.concat(chunks), part.encoding),
      part.charset,
    );
  } catch {
    return undefined;
  }
}

/**
 * Fetch the readable body, preferring the plain-text alternative.
 *
 * Only one part is fetched. Downloading both alternatives would cost an extra
 * round trip per message for a second copy of the same content: every consumer
 * reads `bodyText ?? bodyHtml`, so the one the sender wrote for humans is the
 * one worth having.
 */
async function fetchBody(
  client: ImapFlow,
  uid: number,
  parts: BodyTextParts,
): Promise<{ bodyText?: string; bodyHtml?: string }> {
  if (parts.plain) {
    return { bodyText: await downloadTextPart(client, uid, parts.plain) };
  }
  if (parts.html) {
    return { bodyHtml: await downloadTextPart(client, uid, parts.html) };
  }
  return {};
}

async function messageToEmail(
  msg: Record<string, unknown>,
  client: ImapFlow,
  uid: number,
): Promise<Email> {
  const meta = messageToEmailMeta(msg);
  const envelope = (msg.envelope ?? {}) as Record<string, unknown>;

  // Headers come from BODY.PEEK[HEADER]; parseHeaderBlock unfolds RFC 5322
  // continuation lines, which naive line splitting truncates on fields such as
  // List-Unsubscribe.
  const headers: Record<string, string> = {};
  if (msg.headers && Buffer.isBuffer(msg.headers)) {
    Object.assign(headers, parseHeaderBlock(msg.headers.toString('utf-8')));
  }

  // The body is fetched by MIME section rather than sliced out of the full
  // source. Slicing at the header boundary hands back the raw multipart body —
  // boundaries, base64 attachments and all — whenever the message is not a bare
  // text/plain, which is why this used to be papered over by unconditionally
  // re-downloading section 1 afterwards.
  const { bodyText, bodyHtml } = await fetchBody(client, uid, findBodyTextParts(msg.bodyStructure));

  return {
    ...meta,
    cc: parseAddresses(envelope.cc as Record<string, string>[]),
    bcc: parseAddresses(envelope.bcc as Record<string, string>[]),
    bodyText,
    bodyHtml,
    messageId: (envelope.messageId as string) ?? '',
    inReplyTo: (envelope.inReplyTo as string) ?? undefined,
    references: headers.references?.split(/\s+/).filter(Boolean),
    attachments: extractAttachments(msg.bodyStructure),
    headers,
    // Recomputed from the full header set rather than reusing meta.bulk, which
    // a full fetch leaves unset — the targeted HEADER.FIELDS fetch only happens
    // on listings.
    bulk: classifyBulk(headers),
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export default class ImapService {
  private labelStrategies = new Map<string, LabelStrategy>();

  private labelStrategyPending = new Map<string, Promise<LabelStrategy>>();

  constructor(private connections: IConnectionManager) {}

  private async getLabelStrategy(accountName: string): Promise<LabelStrategy> {
    const cached = this.labelStrategies.get(accountName);
    if (cached) return cached;

    // Deduplicate concurrent detection for the same account
    const pending = this.labelStrategyPending.get(accountName);
    if (pending) return pending;

    const promise = (async () => {
      const client = await this.connections.getImapClient(accountName);
      const strategy = await detectLabelStrategy(client);
      this.labelStrategies.set(accountName, strategy);
      this.labelStrategyPending.delete(accountName);
      return strategy;
    })();

    this.labelStrategyPending.set(accountName, promise);
    return promise;
  }

  // -------------------------------------------------------------------------
  // Mailboxes
  // -------------------------------------------------------------------------

  async listMailboxes(accountName: string): Promise<Mailbox[]> {
    const client = await this.connections.getImapClient(accountName);

    // LIST-STATUS (RFC 5819) returns every folder's counters inline with the
    // folder list, turning what was LIST plus one STATUS per folder into a
    // single command. Gmail advertises it; a plain Dovecot may not.
    if (client.capabilities.has('LIST-STATUS')) {
      const listed = await client.list({ statusQuery: MAILBOX_STATUS_FIELDS });
      return listed.map((mb) => ({
        name: mb.name,
        path: mb.path,
        specialUse: mb.specialUse ?? undefined,
        totalMessages: mb.status?.messages ?? 0,
        unseenMessages: mb.status?.unseen ?? 0,
      }));
    }

    // Without the extension it is one STATUS per folder. Issued through the
    // pool so they genuinely overlap — imapflow's own fallback would run them
    // in turn on a single connection.
    const mailboxes = await client.list();
    const statusResults = await Promise.allSettled(
      mailboxes.map(async (mb) => {
        const readStatus = async (c: ImapFlow) => c.status(mb.path, MAILBOX_STATUS_FIELDS);
        const status = await this.connections.withImapClient(accountName, readStatus);
        return {
          name: mb.name,
          path: mb.path,
          specialUse: mb.specialUse ?? undefined,
          totalMessages: status.messages ?? 0,
          unseenMessages: status.unseen ?? 0,
        };
      }),
    );

    return statusResults.map((result, idx) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      // Fallback for folders that don't support STATUS (e.g. \Noselect)
      const mb = mailboxes[idx];
      return {
        name: mb.name,
        path: mb.path,
        specialUse: mb.specialUse ?? undefined,
        totalMessages: 0,
        unseenMessages: 0,
      };
    });
  }

  // -------------------------------------------------------------------------
  // List emails
  // -------------------------------------------------------------------------

  async listEmails(
    accountName: string,
    options: {
      mailbox?: string;
      page?: number;
      pageSize?: number;
      since?: string;
      before?: string;
      from?: string;
      subject?: string;
      seen?: boolean;
      flagged?: boolean;
      hasAttachment?: boolean;
      answered?: boolean;
      /** Fetch and decode a short body preview. Costs extra bytes per message. */
      preview?: boolean;
    } = {},
  ): Promise<PaginatedResult<EmailMeta>> {
    const client = await this.connections.getImapClient(accountName);
    const mailbox = sanitizeMailboxName(options.mailbox ?? 'INBOX');
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 20;

    const lock = await client.getMailboxLock(mailbox);
    try {
      // Build search criteria
      const search: Record<string, unknown> = {};
      if (options.since) search.since = new Date(options.since);
      if (options.before) search.before = new Date(options.before);
      if (options.from) search.from = options.from;
      if (options.subject) search.subject = options.subject;
      if (options.seen !== undefined) search.seen = options.seen;
      if (options.flagged !== undefined) search.flagged = options.flagged;
      if (options.answered !== undefined) search.answered = options.answered;

      // Search for matching UIDs
      const searchResult = await client.search(search, { uid: true });
      const uids: number[] = Array.isArray(searchResult) ? searchResult : [];

      if (uids.length === 0) {
        return {
          items: [],
          total: 0,
          page,
          pageSize,
          hasMore: false,
        };
      }

      // Sort descending (newest first), then paginate.
      uids.sort((a, b) => b - a);
      const start = (page - 1) * pageSize;

      // hasAttachment has no IMAP equivalent, so it is resolved by inspecting
      // message structure in batches until the page is full — rather than
      // fetching BODYSTRUCTURE for every match before slicing twenty rows out.
      const {
        pageUids,
        total,
        hasMore: moreAfterPage,
        totalIsLowerBound,
      } = options.hasAttachment === undefined
        ? {
            pageUids: uids.slice(start, start + pageSize),
            total: uids.length,
            hasMore: start + pageSize < uids.length,
            totalIsLowerBound: false,
          }
        : await selectPageWithAttachmentFilter(
            client,
            uids,
            options.hasAttachment,
            start,
            pageSize,
          );

      if (pageUids.length === 0) {
        return {
          items: [],
          total,
          page,
          pageSize,
          hasMore: false,
          ...(totalIsLowerBound ? { totalIsLowerBound } : {}),
        };
      }

      const items: EmailMeta[] = [];
      const raw: Record<string, unknown>[] = [];
      const range = pageUids.join(',');

      // eslint-disable-next-line no-restricted-syntax
      for await (const msg of client.fetch(
        range,
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          headers: BULK_HEADER_FIELDS,
          ...(options.preview
            ? { bodyParts: [{ key: '1', start: 0, maxLength: PREVIEW_PART_BYTES }] }
            : {}),
        },
        { uid: true },
      )) {
        raw.push(msg as unknown as Record<string, unknown>);
      }

      if (options.preview) {
        await fetchNestedPreviews(client, raw);
      }

      raw.forEach((msg) => {
        items.push(messageToEmailMeta(msg));
      });

      // Sort by date descending
      items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      return {
        items,
        total,
        page,
        pageSize,
        hasMore: moreAfterPage,
        ...(totalIsLowerBound ? { totalIsLowerBound } : {}),
      };
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Get single email
  // -------------------------------------------------------------------------

  async getEmail(accountName: string, emailId: string, mailbox = 'INBOX'): Promise<Email> {
    // Through the pool rather than the shared connection: get_emails fans out
    // over as many as 20 ids, and on one connection those run strictly in turn.
    const readEmail = async (c: ImapFlow) => ImapService.fetchEmailOn(c, emailId, mailbox);
    return this.connections.withImapClient(accountName, readEmail);
  }

  /** Read one message on a given connection. */
  private static async fetchEmailOn(
    client: ImapFlow,
    emailId: string,
    mailbox: string,
  ): Promise<Email> {
    const uid = parseInt(emailId, 10);
    const safeMailbox = sanitizeMailboxName(mailbox);

    const lock = await client.getMailboxLock(safeMailbox);
    try {
      const msg = await client.fetchOne(
        String(uid),
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          // BODY.PEEK[HEADER], not BODY.PEEK[]. Fetching the whole message
          // pulled every attachment down to display its text, and `maxLength`
          // trims the output afterwards rather than the bytes.
          headers: true,
        },
        { uid: true },
      );

      if (!msg) {
        throw new Error(`Email ${emailId} not found in ${mailbox}`);
      }

      return await messageToEmail(msg as unknown as Record<string, unknown>, client, uid);
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Get sender-authentication signals (lightweight — headers only, no body fetch)
  // -------------------------------------------------------------------------

  async getEmailSecurity(
    accountName: string,
    emailId: string,
    mailbox = 'INBOX',
  ): Promise<EmailSecurityInfo> {
    const client = await this.connections.getImapClient(accountName);
    const uid = parseInt(emailId, 10);
    const safeMailbox = sanitizeMailboxName(mailbox);

    const lock = await client.getMailboxLock(safeMailbox);
    try {
      const msg = await client.fetchOne(
        String(uid),
        { uid: true, envelope: true, headers: true },
        { uid: true },
      );

      if (!msg) {
        throw new Error(`Email ${emailId} not found in ${mailbox}`);
      }

      const headers =
        msg.headers && Buffer.isBuffer(msg.headers)
          ? parseHeaderBlock(msg.headers.toString('utf-8'))
          : {};
      const envelope = (msg.envelope ?? {}) as Record<string, unknown>;
      const from = parseAddress((envelope.from as Record<string, string>[])?.[0]);
      const authenticationResults = headers['authentication-results'] ?? '';
      const receivedSpf = headers['received-spf'] ?? '';
      const spf = new Set(authStatuses(authenticationResults, 'spf'));
      const receivedSpfStatus = /^\s*([a-z][a-z0-9_-]*)/i.exec(receivedSpf)?.[1]?.toLowerCase();
      if (receivedSpfStatus) spf.add(receivedSpfStatus);

      return {
        fromDomain: addressDomain(from.address),
        returnPathDomain: addressDomain(headers['return-path']),
        replyToDomain: addressDomain(headers['reply-to']),
        spf: [...spf],
        dkim: authStatuses(authenticationResults, 'dkim'),
        dmarc: authStatuses(authenticationResults, 'dmarc'),
        dkimDomains: dkimSigningDomains(authenticationResults, headers['dkim-signature'] ?? ''),
        authenticationResultsPresent: Boolean(authenticationResults),
        listUnsubscribe: Boolean(headers['list-unsubscribe']),
      };
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Get email flags (lightweight — no body fetch, no \Seen change)
  // -------------------------------------------------------------------------

  async getEmailFlags(
    accountName: string,
    emailId: string,
    mailbox = 'INBOX',
  ): Promise<{
    seen: boolean;
    flagged: boolean;
    answered: boolean;
    labels: string[];
    subject: string;
    from: string;
    date: string;
  }> {
    const client = await this.connections.getImapClient(accountName);
    const uid = parseInt(emailId, 10);

    const lock = await client.getMailboxLock(mailbox);
    try {
      const msg = await client.fetchOne(
        String(uid),
        { uid: true, envelope: true, flags: true },
        { uid: true },
      );

      if (!msg) {
        throw new Error(`Email ${emailId} not found in ${mailbox}`);
      }

      const raw = msg as unknown as Record<string, unknown>;
      const flags = new Set((raw.flags ?? []) as string[]);
      const labels = [...flags].filter((f) => !f.startsWith('\\'));
      const envelope = (raw.envelope ?? {}) as Record<string, unknown>;
      const fromEntry = (envelope.from as Record<string, string>[] | undefined)?.[0];
      let from = '';
      if (fromEntry) {
        from = fromEntry.name
          ? `${fromEntry.name} <${fromEntry.address}>`
          : (fromEntry.address ?? '');
      }

      return {
        seen: flags.has('\\Seen'),
        flagged: flags.has('\\Flagged'),
        answered: flags.has('\\Answered'),
        labels,
        subject: (envelope.subject as string) ?? '(no subject)',
        from,
        date: envelope.date ? new Date(envelope.date as string).toISOString() : '',
      };
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Search emails
  // -------------------------------------------------------------------------

  /**
   * Build the IMAP SEARCH criteria shared by the single- and multi-folder paths.
   */
  private static buildSearchCriteria(
    sanitizedQuery: string,
    options: {
      to?: string;
      largerThan?: number;
      smallerThan?: number;
      answered?: boolean;
    },
    includeBody = true,
  ): Record<string, unknown> {
    // Base query ORs across subject, sender and — where it is affordable — body.
    const terms: Record<string, unknown>[] = [
      { subject: sanitizedQuery },
      { from: sanitizedQuery },
      ...(includeBody ? [{ body: sanitizedQuery }] : []),
    ];
    const baseCriteria: Record<string, unknown> = sanitizedQuery ? { or: terms } : {};

    const andConditions: Record<string, unknown>[] = [baseCriteria];
    if (options.to) {
      andConditions.push({ to: options.to });
    }
    if (options.largerThan !== undefined) {
      andConditions.push({ larger: options.largerThan * 1024 });
    }
    if (options.smallerThan !== undefined) {
      andConditions.push({ smaller: options.smallerThan * 1024 });
    }
    if (options.answered === true) {
      andConditions.push({ answered: true });
    } else if (options.answered === false) {
      andConditions.push({ answered: false });
    }

    if (andConditions.length === 1) return baseCriteria;

    const combined: Record<string, unknown> = {};
    andConditions.forEach((condition) => {
      Object.assign(combined, condition);
    });
    return combined;
  }

  /** Fetch listing metadata for a set of UIDs in the currently selected mailbox. */
  private static async fetchMetasFor(
    client: ImapFlow,
    uids: number[],
    withPreview: boolean,
  ): Promise<EmailMeta[]> {
    if (uids.length === 0) return [];

    const raw: Record<string, unknown>[] = [];
    // eslint-disable-next-line no-restricted-syntax
    for await (const msg of client.fetch(
      uids.join(','),
      {
        uid: true,
        envelope: true,
        flags: true,
        bodyStructure: true,
        headers: BULK_HEADER_FIELDS,
        ...(withPreview
          ? { bodyParts: [{ key: '1', start: 0, maxLength: PREVIEW_PART_BYTES }] }
          : {}),
      },
      { uid: true },
    )) {
      raw.push(msg as unknown as Record<string, unknown>);
    }

    if (withPreview) {
      await fetchNestedPreviews(client, raw);
    }

    return raw.map((msg) => messageToEmailMeta(msg));
  }

  /**
   * Folders worth searching for an account.
   *
   * Gmail files every message under All Mail whatever labels it carries, so one
   * folder covers the whole account. Elsewhere it means every real folder;
   * Trash and Junk are left out, which is also what All Mail excludes.
   */
  private static async searchableMailboxes(
    client: ImapFlow,
  ): Promise<{ mailboxes: string[]; indexed: boolean }> {
    const mailboxes = await client.list();

    const allMail = mailboxes.find((mb) => mb.specialUse === '\\All');
    if (allMail && client.capabilities.has('X-GM-EXT-1')) {
      // One folder holding every message, searched by the server's own index.
      return { mailboxes: [allMail.path], indexed: true };
    }

    const skipped = new Set(['\\All', '\\Flagged', '\\Trash', '\\Junk']);
    const searchable = mailboxes
      .filter((mb) => mb.listed && !mb.flags?.has('\\Noselect'))
      .filter(
        (mb) => !skipped.has(mb.specialUse ?? '') && ![...skipped].some((f) => mb.flags?.has(f)),
      );

    // Most likely first, so a search cut short by the deadline has spent its
    // time on the folders the answer is most likely to be in.
    return {
      mailboxes: ImapService.orderByLikelihood(searchable).map((mb) => mb.path),
      indexed: false,
    };
  }

  /** What every folder in one cross-folder search has in common. */
  private static asSearchPlan(plan: {
    /** Used where the server indexes, or where the folder is small enough. */
    criteriaWithBody: Record<string, unknown>;
    /** Used on a large folder of a server that has to scan for a body match. */
    criteriaHeadersOnly: Record<string, unknown>;
    /** True when the server indexes, so folder size does not matter. */
    indexed: boolean;
    candidateLimit: number;
    withPreview: boolean;
  }) {
    return plan;
  }

  /** Search one folder and return its newest matches, tagged with their source. */
  private async searchOneMailbox(
    accountName: string,
    mailbox: string,
    plan: ReturnType<typeof ImapService.asSearchPlan>,
  ): Promise<{
    mailbox: string;
    metas: EmailMeta[];
    matched: number;
    capped: boolean;
    bodySkipped: boolean;
  }> {
    const { candidateLimit, withPreview } = plan;
    return this.connections.withImapClient(accountName, async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        // SELECT has just reported how many messages the folder holds, so
        // choosing here costs nothing.
        const selected = client.mailbox;
        const messageCount = typeof selected === 'object' ? (selected.exists ?? 0) : 0;
        const affordable = plan.indexed || messageCount <= BODY_SEARCH_MAX_MESSAGES;
        const criteria = affordable ? plan.criteriaWithBody : plan.criteriaHeadersOnly;

        const found = await client.search(criteria, { uid: true });
        const uids = (Array.isArray(found) ? found : []).sort((a, b) => b - a);
        // UIDs rise with arrival, so the newest by UID are the newest by date.
        // Taking only as many as a page could need keeps the envelope fetch
        // bounded no matter how many messages matched.
        const candidates = uids.slice(0, candidateLimit);
        const metas = await ImapService.fetchMetasFor(client, candidates, withPreview);
        return {
          mailbox,
          metas: metas.map((meta) => ({ ...meta, account: accountName, mailbox })),
          matched: uids.length,
          capped: uids.length > candidates.length,
          bodySkipped: !affordable,
        };
      } finally {
        lock.release();
      }
    });
  }

  /**
   * Search across folders, and optionally across accounts.
   *
   * Every source is searched by the server; nothing is filtered here. Results
   * carry the account and folder they came from, because a UID is meaningless
   * without them — a caller cannot move or delete a result otherwise.
   */
  async searchAcross(
    scope: string[] | 'all',
    query: string,
    options: {
      page?: number;
      pageSize?: number;
      to?: string;
      largerThan?: number;
      smallerThan?: number;
      answered?: boolean;
      preview?: boolean;
    } = {},
  ): Promise<PaginatedResult<EmailMeta>> {
    // Resolving 'all' here keeps the account list out of the tool layer, which
    // has no connection manager of its own.
    const accountNames = scope === 'all' ? this.connections.getAccountNames() : scope;

    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 20;
    const start = (page - 1) * pageSize;
    const sanitizedQuery = query ? sanitizeSearchQuery(query) : '';
    // Enough from each source that merging them can fill the requested page.
    const candidateLimit = Math.min(start + pageSize, MAX_CANDIDATES_PER_SOURCE);
    const withPreview = options.preview ?? false;

    // One deadline for the whole search, not one per folder: what a caller
    // cares about is when an answer arrives, and a per-folder timeout still
    // adds up to minutes across three hundred of them.
    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'deadline'>((resolve) => {
      deadlineTimer = setTimeout(() => resolve('deadline'), CROSS_FOLDER_DEADLINE_MS);
      deadlineTimer.unref?.();
    });

    const collected: EmailMeta[] = [];
    const incompleteSources: string[] = [];
    const bodySkippedFolders: string[] = [];
    let matched = 0;
    let capped = false;

    try {
      const perAccount = await Promise.all(
        accountNames.map(async (accountName) => {
          const client = await this.connections.getImapClient(accountName);
          const { mailboxes, indexed } = await ImapService.searchableMailboxes(client);

          // The body term is decided per folder, once SELECT has said how big
          // the folder is — see BODY_SEARCH_MAX_MESSAGES. Both variants are
          // built once here rather than per folder.
          const plan = ImapService.asSearchPlan({
            criteriaWithBody: ImapService.buildSearchCriteria(sanitizedQuery, options, true),
            criteriaHeadersOnly: ImapService.buildSearchCriteria(sanitizedQuery, options, false),
            indexed,
            candidateLimit,
            withPreview,
          });

          const search = async (mb: string) => {
            const outcome = await Promise.race([
              this.searchOneMailbox(accountName, mb, plan),
              deadline,
            ]);
            return outcome === 'deadline' ? { source: `${accountName}/${mb}` } : outcome;
          };
          return Promise.allSettled(mailboxes.map(search));
        }),
      );

      perAccount.flat().forEach((outcome) => {
        // A folder that cannot be selected or searched drops out rather than
        // failing the whole search.
        if (outcome.status !== 'fulfilled') return;
        if ('source' in outcome.value) {
          incompleteSources.push(outcome.value.source);
          return;
        }
        collected.push(...outcome.value.metas);
        matched += outcome.value.matched;
        capped ||= outcome.value.capped;
        if (outcome.value.bodySkipped) bodySkippedFolders.push(outcome.value.mailbox);
      });
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }

    // The same message can sit in several folders — Gmail labels most of all.
    const bySource = new Map<string, EmailMeta>();
    collected.forEach((meta) => {
      const key = `${meta.account}\u0000${meta.id}\u0000${meta.mailbox}`;
      bySource.set(key, meta);
    });

    const merged = [...bySource.values()].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );

    return {
      items: merged.slice(start, start + pageSize),
      total: matched,
      page,
      pageSize,
      hasMore: merged.length > start + pageSize || capped,
      // Either the per-source cap or an unfinished source means the count is a
      // floor, not a total.
      ...(capped || incompleteSources.length > 0 ? { totalIsLowerBound: true } : {}),
      ...(incompleteSources.length > 0 ? { incompleteSources } : {}),
      ...(bodySkippedFolders.length > 0 ? { bodyNotSearched: bodySkippedFolders } : {}),
    };
  }

  async searchEmails(
    accountName: string,
    query: string,
    options: {
      mailbox?: string;
      page?: number;
      pageSize?: number;
      to?: string;
      hasAttachment?: boolean;
      largerThan?: number;
      smallerThan?: number;
      answered?: boolean;
      /** Fetch and decode a short body preview. Costs extra bytes per message. */
      preview?: boolean;
    } = {},
  ): Promise<PaginatedResult<EmailMeta>> {
    const client = await this.connections.getImapClient(accountName);
    const mailbox = sanitizeMailboxName(options.mailbox ?? 'INBOX');
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 20;
    const sanitizedQuery = query ? sanitizeSearchQuery(query) : '';

    const lock = await client.getMailboxLock(mailbox);
    try {
      const searchCriteria = ImapService.buildSearchCriteria(sanitizedQuery, options);

      const searchResult = await client.search(searchCriteria, { uid: true });
      const uids: number[] = Array.isArray(searchResult) ? searchResult : [];

      if (uids.length === 0) {
        return {
          items: [],
          total: 0,
          page,
          pageSize,
          hasMore: false,
        };
      }

      uids.sort((a, b) => b - a);
      const start = (page - 1) * pageSize;

      // has_attachment has no IMAP equivalent; see selectPageWithAttachmentFilter.
      const {
        pageUids,
        total,
        hasMore: moreAfterPage,
        totalIsLowerBound,
      } = options.hasAttachment === undefined
        ? {
            pageUids: uids.slice(start, start + pageSize),
            total: uids.length,
            hasMore: start + pageSize < uids.length,
            totalIsLowerBound: false,
          }
        : await selectPageWithAttachmentFilter(
            client,
            uids,
            options.hasAttachment,
            start,
            pageSize,
          );

      if (pageUids.length === 0) {
        return {
          items: [],
          total,
          page,
          pageSize,
          hasMore: false,
          ...(totalIsLowerBound ? { totalIsLowerBound } : {}),
        };
      }

      const items: EmailMeta[] = [];
      const raw: Record<string, unknown>[] = [];
      const range = pageUids.join(',');

      // eslint-disable-next-line no-restricted-syntax
      for await (const msg of client.fetch(
        range,
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          headers: BULK_HEADER_FIELDS,
          ...(options.preview
            ? { bodyParts: [{ key: '1', start: 0, maxLength: PREVIEW_PART_BYTES }] }
            : {}),
        },
        { uid: true },
      )) {
        raw.push(msg as unknown as Record<string, unknown>);
      }

      if (options.preview) {
        await fetchNestedPreviews(client, raw);
      }

      raw.forEach((msg) => {
        items.push(messageToEmailMeta(msg));
      });

      items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      return {
        items,
        total,
        page,
        pageSize,
        hasMore: moreAfterPage,
        ...(totalIsLowerBound ? { totalIsLowerBound } : {}),
      };
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Labels
  // -------------------------------------------------------------------------

  async listLabels(accountName: string): Promise<LabelInfo[]> {
    const strategy = await this.getLabelStrategy(accountName);
    const client = await this.connections.getImapClient(accountName);
    return strategy.listLabels(client);
  }

  async addLabel(
    accountName: string,
    emailId: string,
    mailbox: string,
    label: string,
  ): Promise<void> {
    const strategy = await this.getLabelStrategy(accountName);
    const client = await this.connections.getImapClient(accountName);
    await strategy.addLabel(client, emailId, mailbox, label);
  }

  async removeLabel(
    accountName: string,
    emailId: string,
    mailbox: string,
    label: string,
  ): Promise<void> {
    const strategy = await this.getLabelStrategy(accountName);
    const client = await this.connections.getImapClient(accountName);
    await strategy.removeLabel(client, emailId, mailbox, label);
  }

  async createLabel(accountName: string, name: string): Promise<void> {
    const strategy = await this.getLabelStrategy(accountName);
    const client = await this.connections.getImapClient(accountName);
    await strategy.createLabel(client, name);
  }

  async deleteLabel(accountName: string, name: string): Promise<void> {
    const strategy = await this.getLabelStrategy(accountName);
    const client = await this.connections.getImapClient(accountName);
    await strategy.deleteLabel(client, name);
  }

  // -------------------------------------------------------------------------
  // Virtual-folder detection
  // -------------------------------------------------------------------------

  private static readonly VIRTUAL_SPECIAL_USE = new Set(['\\All', '\\Flagged']);

  private static async assertRealMailbox(client: ImapFlow, mailboxPath: string): Promise<void> {
    const mailboxes = await client.list();
    const mb = mailboxes.find((m) => m.path === mailboxPath);
    if (!mb) return; // unknown — let the server reject if invalid
    const virtualFlag = [...ImapService.VIRTUAL_SPECIAL_USE].find(
      (f) => mb.specialUse === f || mb.flags?.has(f),
    );
    if (virtualFlag) {
      throw new Error(
        `"${mailboxPath}" is a virtual folder (${virtualFlag}). ` +
          'Use find_email_folder to locate the real folder first.',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Find real folder for an email
  // -------------------------------------------------------------------------

  /** Folders a message is most likely to be in, in the order worth searching. */
  private static readonly LIKELY_SPECIAL_USE = ['\\Sent', '\\Drafts', '\\Archive'];

  /**
   * Order mailboxes so the first match is the one a caller would want to act
   * on, since the search stops there.
   */
  private static orderByLikelihood<T extends { path: string; specialUse?: string }>(
    mailboxes: T[],
  ): T[] {
    const rank = (mailbox: T): number => {
      if (mailbox.path === 'INBOX') return 0;
      const specialIndex = mailbox.specialUse
        ? ImapService.LIKELY_SPECIAL_USE.indexOf(mailbox.specialUse)
        : -1;
      return specialIndex === -1 ? ImapService.LIKELY_SPECIAL_USE.length + 1 : specialIndex + 1;
    };
    // Stable within a rank, so the server's own ordering is otherwise kept.
    return [...mailboxes].sort((a, b) => rank(a) - rank(b));
  }

  async findEmailFolder(
    accountName: string,
    emailId: string,
    sourceMailbox: string,
  ): Promise<{ folders: string[]; messageId?: string }> {
    const client = await this.connections.getImapClient(accountName);

    // 1. Fetch Message-ID from the source mailbox
    let messageId: string | undefined;
    const srcLock = await client.getMailboxLock(sourceMailbox);
    try {
      const msg = await client.fetchOne(emailId, { headers: true }, { uid: true });
      // biome-ignore lint/complexity/useOptionalChain: optional chain breaks TS type narrowing for union with false
      if (msg && msg.headers && Buffer.isBuffer(msg.headers)) {
        const headerText = msg.headers.toString('utf-8');
        const match = /^message-id:\s*(.+)$/im.exec(headerText);
        if (match) {
          messageId = match[1].trim();
        }
      }
    } finally {
      srcLock.release();
    }

    if (!messageId) {
      throw new Error('Could not retrieve Message-ID for this email.');
    }

    // 2. List all real mailboxes (exclude virtual and non-selectable)
    const allMailboxes = await client.list();
    const realMailboxes = allMailboxes.filter((mb) => {
      if (!mb.listed) return false;
      if (mb.flags?.has('\\Noselect')) return false;
      const isVirtual = [...ImapService.VIRTUAL_SPECIAL_USE].some(
        (f) => mb.specialUse === f || mb.flags?.has(f),
      );
      if (isVirtual) return false;
      return true;
    });

    // 3. Search for the Message-ID, stopping at the first hit.
    //
    // Each folder costs a SELECT and a header SEARCH, and header SEARCH is
    // typically an unindexed server-side scan. Continuing after a match spent
    // that on every remaining folder to produce a list the caller was told to
    // take the first entry of.
    //
    // Likely folders go first so the one hit is also the useful one: a message
    // is far more often in INBOX or Sent than in an archive label, and on a
    // label-based server it is in several folders at once.
    const searchOrder = ImapService.orderByLikelihood(realMailboxes);

    const folders: string[] = [];
    const findInMailbox = async (mbPath: string): Promise<boolean> => {
      try {
        const lock = await client.getMailboxLock(mbPath);
        try {
          const results = await client.search(
            { header: { 'message-id': messageId } },
            { uid: true },
          );
          return Array.isArray(results) && results.length > 0;
        } finally {
          lock.release();
        }
      } catch {
        // Skip folders that can't be selected or searched (e.g. \Noselect, INBOX on some providers)
        return false;
      }
    };
    // eslint-disable-next-line no-restricted-syntax
    for (const mb of searchOrder) {
      // eslint-disable-next-line no-await-in-loop
      if (await findInMailbox(mb.path)) {
        folders.push(mb.path);
        break;
      }
    }

    return { folders, messageId };
  }

  // -------------------------------------------------------------------------
  // Move / Delete
  // -------------------------------------------------------------------------

  async moveEmail(
    accountName: string,
    emailId: string,
    sourceMailbox: string,
    destinationMailbox: string,
  ): Promise<void> {
    const client = await this.connections.getImapClient(accountName);
    const safeSource = sanitizeMailboxName(sourceMailbox);
    const safeDest = sanitizeMailboxName(destinationMailbox);
    await ImapService.assertRealMailbox(client, safeSource);
    const lock = await client.getMailboxLock(safeSource);
    try {
      const ok = await client.messageMove(emailId, safeDest, { uid: true });
      if (!ok) {
        throw new Error(`IMAP server rejected the move from "${safeSource}" to "${safeDest}".`);
      }
    } finally {
      lock.release();
    }
  }

  async deleteEmail(
    accountName: string,
    emailId: string,
    mailbox = 'INBOX',
    permanent = false,
  ): Promise<void> {
    const client = await this.connections.getImapClient(accountName);
    const safeMailbox = sanitizeMailboxName(mailbox);

    if (permanent) {
      const lock = await client.getMailboxLock(safeMailbox);
      try {
        const ok = await client.messageDelete(emailId, { uid: true });
        if (!ok) {
          throw new Error('IMAP server rejected the delete operation.');
        }
      } finally {
        lock.release();
      }
    } else {
      await ImapService.assertRealMailbox(client, safeMailbox);
      const mailboxes = await client.list();
      const trash = mailboxes.find((mb) => mb.specialUse === '\\Trash');
      const trashPath = trash?.path ?? 'Trash';

      const lock = await client.getMailboxLock(safeMailbox);
      try {
        const ok = await client.messageMove(emailId, trashPath, { uid: true });
        if (!ok) {
          throw new Error('IMAP server rejected the move to Trash.');
        }
      } finally {
        lock.release();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Flag management
  // -------------------------------------------------------------------------

  async setFlags(
    accountName: string,
    emailId: string,
    mailbox: string,
    action: 'read' | 'unread' | 'flag' | 'unflag',
  ): Promise<void> {
    const client = await this.connections.getImapClient(accountName);
    const safeMailbox = sanitizeMailboxName(mailbox);
    const lock = await client.getMailboxLock(safeMailbox);
    try {
      const flagMap: Record<string, { flags: string[]; add: boolean }> = {
        read: { flags: ['\\Seen'], add: true },
        unread: { flags: ['\\Seen'], add: false },
        flag: { flags: ['\\Flagged'], add: true },
        unflag: { flags: ['\\Flagged'], add: false },
      };
      const { flags, add } = flagMap[action];
      let ok: boolean;
      if (add) {
        ok = await client.messageFlagsAdd(emailId, flags, { uid: true });
      } else {
        ok = await client.messageFlagsRemove(emailId, flags, { uid: true });
      }
      if (!ok) {
        throw new Error(`IMAP server rejected the ${action} flag operation.`);
      }
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Bulk operations
  // -------------------------------------------------------------------------

  async bulkSetFlags(
    accountName: string,
    ids: number[],
    mailbox: string,
    action: 'mark_read' | 'mark_unread' | 'flag' | 'unflag',
  ): Promise<BulkResult> {
    const client = await this.connections.getImapClient(accountName);
    const lock = await client.getMailboxLock(mailbox);
    const result: BulkResult = {
      total: ids.length,
      succeeded: 0,
      failed: 0,
      errors: [],
    };
    try {
      const flagMap: Record<string, { flags: string[]; add: boolean }> = {
        mark_read: { flags: ['\\Seen'], add: true },
        mark_unread: { flags: ['\\Seen'], add: false },
        flag: { flags: ['\\Flagged'], add: true },
        unflag: { flags: ['\\Flagged'], add: false },
      };
      const { flags, add } = flagMap[action];
      const range = ids.join(',');
      let ok: boolean;
      if (add) {
        ok = await client.messageFlagsAdd(range, flags, { uid: true });
      } else {
        ok = await client.messageFlagsRemove(range, flags, { uid: true });
      }
      if (ok) {
        result.succeeded = ids.length;
      } else {
        result.failed = ids.length;
        result.errors = ['IMAP server rejected the flag operation.'];
      }
    } catch (err) {
      result.failed = ids.length;
      result.errors = [err instanceof Error ? err.message : String(err)];
    } finally {
      lock.release();
    }
    if (result.errors?.length === 0) delete result.errors;
    return result;
  }

  async bulkMove(
    accountName: string,
    ids: number[],
    mailbox: string,
    destination: string,
  ): Promise<BulkResult> {
    const client = await this.connections.getImapClient(accountName);
    await ImapService.assertRealMailbox(client, mailbox);
    const lock = await client.getMailboxLock(mailbox);
    const result: BulkResult = {
      total: ids.length,
      succeeded: 0,
      failed: 0,
      errors: [],
    };
    try {
      const range = ids.join(',');
      const ok = await client.messageMove(range, destination, { uid: true });
      if (ok) {
        result.succeeded = ids.length;
      } else {
        result.failed = ids.length;
        result.errors = ['IMAP server rejected the move operation.'];
      }
    } catch (err) {
      result.failed = ids.length;
      result.errors = [err instanceof Error ? err.message : String(err)];
    } finally {
      lock.release();
    }
    if (result.errors?.length === 0) delete result.errors;
    return result;
  }

  async bulkDelete(
    accountName: string,
    ids: number[],
    mailbox: string,
    permanent = false,
  ): Promise<BulkResult> {
    const client = await this.connections.getImapClient(accountName);
    const result: BulkResult = {
      total: ids.length,
      succeeded: 0,
      failed: 0,
      errors: [],
    };

    if (permanent) {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const range = ids.join(',');
        const ok = await client.messageDelete(range, { uid: true });
        if (ok) {
          result.succeeded = ids.length;
        } else {
          result.failed = ids.length;
          result.errors = ['IMAP server rejected the delete operation.'];
        }
      } catch (err) {
        result.failed = ids.length;
        result.errors = [err instanceof Error ? err.message : String(err)];
      } finally {
        lock.release();
      }
    } else {
      await ImapService.assertRealMailbox(client, mailbox);
      const mailboxes = await client.list();
      const trash = mailboxes.find((mb) => mb.specialUse === '\\Trash');
      const trashPath = trash?.path ?? 'Trash';

      const lock = await client.getMailboxLock(mailbox);
      try {
        const range = ids.join(',');
        const ok = await client.messageMove(range, trashPath, { uid: true });
        if (ok) {
          result.succeeded = ids.length;
        } else {
          result.failed = ids.length;
          result.errors = ['IMAP server rejected the move to Trash.'];
        }
      } catch (err) {
        result.failed = ids.length;
        result.errors = [err instanceof Error ? err.message : String(err)];
      } finally {
        lock.release();
      }
    }

    if (result.errors?.length === 0) delete result.errors;
    return result;
  }

  // -------------------------------------------------------------------------
  // Draft management
  // -------------------------------------------------------------------------

  async saveDraft(
    accountName: string,
    options: {
      to: string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
      html?: boolean;
      inReplyTo?: string;
      attachments?: AttachmentInput[];
    },
  ): Promise<{ id: number; mailbox: string }> {
    await validateAttachments(options.attachments);

    const client = await this.connections.getImapClient(accountName);
    const account = this.connections.getAccount(accountName);

    // Find the Drafts folder
    const mailboxes = await client.list();
    const drafts = mailboxes.find((mb) => mb.specialUse === '\\Drafts');
    const draftsPath = drafts?.path ?? 'Drafts';

    let rawMessage: Buffer;

    if (options.attachments?.length) {
      // Build a proper MIME message so attachments survive as separate parts.
      const attachments = await resolveAttachments(options.attachments);
      rawMessage = await buildRawMessage({
        from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
        to: options.to.join(', '),
        cc: options.cc?.join(', '),
        bcc: options.bcc?.join(', '),
        subject: options.subject,
        inReplyTo: options.inReplyTo,
        attachments,
        ...(options.html ? { html: options.body } : { text: options.body }),
      });
    } else {
      // Construct RFC 822 message
      const headers = [
        `From: ${account.fullName ? `"${account.fullName}" <${account.email}>` : account.email}`,
        `To: ${options.to.join(', ')}`,
        `Subject: ${options.subject}`,
        `Date: ${new Date().toUTCString()}`,
        `MIME-Version: 1.0`,
      ];

      if (options.cc?.length) headers.push(`Cc: ${options.cc.join(', ')}`);
      if (options.bcc?.length) headers.push(`Bcc: ${options.bcc.join(', ')}`);
      if (options.inReplyTo) headers.push(`In-Reply-To: ${options.inReplyTo}`);

      const contentType = options.html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
      headers.push(`Content-Type: ${contentType}`);

      rawMessage = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${options.body}`);
    }

    const appendResult = await client.append(draftsPath, rawMessage, ['\\Draft', '\\Seen']);

    return {
      id: (appendResult as unknown as { uid?: number }).uid ?? 0,
      mailbox: draftsPath,
    };
  }

  /**
   * Fetch a draft message for sending.
   * Returns the parsed draft with recipients and content.
   */
  async fetchDraft(
    accountName: string,
    emailId: number,
    mailbox?: string,
  ): Promise<{
    email: Email;
    mailbox: string;
  }> {
    const client = await this.connections.getImapClient(accountName);

    // Find drafts folder if not specified
    let draftsPath = mailbox;
    if (!draftsPath) {
      const mailboxes = await client.list();
      const draftsFolder = mailboxes.find((mb) => mb.specialUse === '\\Drafts');
      draftsPath = draftsFolder?.path ?? 'Drafts';
    }

    const email = await this.getEmail(accountName, String(emailId), draftsPath);
    return { email, mailbox: draftsPath };
  }

  /**
   * File a copy of an outgoing message in the account's Sent folder.
   *
   * SMTP only hands the message to the next hop; nothing about sending puts a
   * copy in the mailbox. Mail clients APPEND it themselves, so a server-side
   * sender that skips this leaves no record of what it sent.
   */
  async appendToSent(accountName: string, raw: Buffer): Promise<string | null> {
    const client = await this.connections.getImapClient(accountName);
    const account = this.connections.getAccount(accountName);

    if (!shouldFileSentCopy(account, client)) {
      return null;
    }

    // A server that does not advertise SPECIAL-USE makes the client guess the
    // Sent folder from its name, and the guess loses on a mailbox that carries
    // several sent-shaped folders left by different clients over the years — it
    // can land on an empty one nobody reads. `sent_mailbox` settles it.
    let sentPath = account.sentMailbox;
    if (!sentPath) {
      const mailboxes = await client.list();
      sentPath = mailboxes.find((mb) => mb.specialUse === '\\Sent')?.path ?? 'Sent';
    }

    await client.append(sentPath, raw, ['\\Seen']);

    return sentPath;
  }

  /** Delete a draft after it has been sent. */
  async deleteDraft(accountName: string, emailId: number, mailbox: string): Promise<void> {
    const client = await this.connections.getImapClient(accountName);
    const lock = await client.getMailboxLock(mailbox);
    try {
      await client.messageDelete(String(emailId), { uid: true });
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Mailbox (folder) CRUD
  // -------------------------------------------------------------------------

  async createMailbox(accountName: string, folderPath: string): Promise<void> {
    const client = await this.connections.getImapClient(accountName);
    await client.mailboxCreate(folderPath);
  }

  async renameMailbox(accountName: string, folderPath: string, newPath: string): Promise<void> {
    const client = await this.connections.getImapClient(accountName);
    await client.mailboxRename(folderPath, newPath);
  }

  async deleteMailbox(accountName: string, folderPath: string): Promise<void> {
    const client = await this.connections.getImapClient(accountName);
    await client.mailboxDelete(folderPath);
  }

  // -------------------------------------------------------------------------
  // Attachment download
  // -------------------------------------------------------------------------

  async downloadAttachment(
    accountName: string,
    emailId: string,
    mailbox: string,
    filename: string,
    maxSizeBytes = 5 * 1024 * 1024,
  ): Promise<{
    filename: string;
    mimeType: string;
    size: number;
    contentBase64: string;
  }> {
    const client = await this.connections.getImapClient(accountName);
    const uid = parseInt(emailId, 10);

    const lock = await client.getMailboxLock(mailbox);
    try {
      // Fetch bodyStructure to find the MIME part
      const msg = await client.fetchOne(
        String(uid),
        { uid: true, bodyStructure: true },
        { uid: true },
      );

      if (!msg) {
        throw new Error(`Email ${emailId} not found in ${mailbox}`);
      }

      const attachments = extractAttachments(msg.bodyStructure);
      const attachment = attachments.find((a) => a.filename === filename);
      if (!attachment) {
        throw new Error(
          `Attachment "${filename}" not found. Available: ${attachments.map((a) => a.filename).join(', ') || 'none'}`,
        );
      }

      if (attachment.size > maxSizeBytes) {
        throw new Error(
          `Attachment "${filename}" is ${Math.round(attachment.size / 1024 / 1024)}MB, exceeds ${Math.round(maxSizeBytes / 1024 / 1024)}MB limit`,
        );
      }

      // Find the MIME part number
      const partNumber = findMimePartByFilename(msg.bodyStructure, filename);
      if (!partNumber) {
        throw new Error(`Could not locate MIME part for "${filename}"`);
      }

      // Download the part
      const downloadResult = await client.download(String(uid), partNumber, {
        uid: true,
      });

      if (!downloadResult?.content) {
        throw new Error(`Failed to download attachment "${filename}"`);
      }

      const chunks: Buffer[] = [];
      // eslint-disable-next-line no-restricted-syntax
      for await (const chunk of downloadResult.content) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const content = Buffer.concat(chunks);

      return {
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: content.length,
        contentBase64: content.toString('base64'),
      };
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Save all email attachments to a local directory
  // -------------------------------------------------------------------------

  /**
   * Download and save all non-ICS attachments from an email to a local directory.
   * Returns metadata including the saved file paths and file:// URLs.
   *
   * Attachments larger than maxSizeBytes (default 25 MB) are skipped.
   */
  async saveEmailAttachments(
    accountName: string,
    emailId: string,
    mailbox: string,
    destDir: string,
    maxSizeBytes = 25 * 1024 * 1024,
  ): Promise<
    {
      filename: string;
      localPath: string;
      fileUrl: string;
      mimeType: string;
      size: number;
    }[]
  > {
    const client = await this.connections.getImapClient(accountName);
    const uid = parseInt(emailId, 10);

    const lock = await client.getMailboxLock(mailbox);
    let attachmentMetas: AttachmentMeta[] = [];
    try {
      const msg = await client.fetchOne(
        String(uid),
        { uid: true, bodyStructure: true },
        { uid: true },
      );
      if (!msg) return [];
      // biome-ignore format: line too long; eslint implicit-arrow-linebreak prevents multi-line implicit return
      attachmentMetas = extractAttachments(msg.bodyStructure).filter((a) => a.size <= maxSizeBytes && !a.mimeType.includes('calendar') && !a.filename.toLowerCase().endsWith('.ics'));
    } finally {
      lock.release();
    }

    if (attachmentMetas.length === 0) return [];

    const { mkdir } = await import('node:fs/promises');
    await mkdir(destDir, { recursive: true });

    const results = await Promise.allSettled(
      attachmentMetas.map(async (meta) => {
        const downloaded = await this.downloadAttachment(
          accountName,
          emailId,
          mailbox,
          meta.filename,
          maxSizeBytes,
        );
        const safe = meta.filename.replace(/[/\\?%*:|"<>]/g, '_');
        const localPath = `${destDir}/${safe}`;
        const { writeFile } = await import('node:fs/promises');
        await writeFile(localPath, Buffer.from(downloaded.contentBase64, 'base64'));
        return {
          filename: meta.filename,
          localPath,
          fileUrl: `file://${localPath}`,
          mimeType: meta.mimeType,
          size: downloaded.size,
        };
      }),
    );

    type FulfilledValue = (typeof results)[0] extends PromiseFulfilledResult<infer T> ? T : never;
    return results
      .filter((r) => r.status === 'fulfilled')
      .map((r) => (r as PromiseFulfilledResult<FulfilledValue>).value);
  }

  /**
   * Search one header against many values in as few commands as possible.
   *
   * One SEARCH per Message-ID was the dominant cost of building a thread:
   * header SEARCH is typically an unindexed server-side scan, and a thread of
   * twenty references issued sixty of them in sequence. IMAP can OR the terms
   * into a single command instead.
   *
   * The OR chain is still chunked: imapflow nests OR pairwise, so an unbounded
   * list produces a deeply nested command that some servers reject outright.
   */
  private static async searchHeaderAnyOf(
    client: ImapFlow,
    headerName: string,
    values: string[],
  ): Promise<number[]> {
    const CHUNK = 25;
    const found: number[] = [];

    for (let offset = 0; offset < values.length; offset += CHUNK) {
      const chunk = values.slice(offset, offset + CHUNK);
      const criteria =
        chunk.length === 1
          ? { header: { [headerName]: chunk[0] } }
          : { or: chunk.map((value) => ({ header: { [headerName]: value } })) };

      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await client.search(criteria, { uid: true });
        if (Array.isArray(result)) found.push(...result);
      } catch {
        // Header search is not supported everywhere; a miss is not an error.
      }
    }

    return found;
  }

  /**
   * Reconstruct an email thread by following References / In-Reply-To chains.
   * Searches by Message-ID header for each reference and returns messages in
   * chronological order. Caps at MAX_THREAD_MESSAGES to prevent runaway chains.
   */
  async getThread(
    accountName: string,
    messageId: string,
    mailbox = 'INBOX',
  ): Promise<{
    threadId: string;
    messages: Email[];
    participants: EmailAddress[];
    messageCount: number;
  }> {
    const MAX_THREAD_MESSAGES = 50;
    const client = await this.connections.getImapClient(accountName);
    const lock = await client.getMailboxLock(mailbox);
    try {
      // Collect all Message-IDs in the thread
      const targetMsgIds = new Set<string>([messageId]);

      // Set when the server threads messages itself: Gmail's X-GM-THRID, or
      // THREADID from OBJECTID. Following References is the fallback for
      // servers that do not.
      let serverThreadId: string | undefined;

      // First, find the root message to get its References chain
      const rootSearch = await client.search(
        { header: { 'Message-ID': messageId } },
        { uid: true },
      );
      const rootUids: number[] = Array.isArray(rootSearch) ? rootSearch : [];

      if (rootUids.length > 0) {
        const rootMsg = await client.fetchOne(
          String(rootUids[0]),
          // Only the References header is read below, so do not pull the body.
          // threadId rides along at no extra cost and, where the server keeps
          // its own threading, replaces the header chasing entirely.
          { uid: true, envelope: true, headers: true, threadId: true },
          { uid: true },
        );

        if (rootMsg) {
          const raw = rootMsg as unknown as Record<string, unknown>;
          if (typeof raw.threadId === 'string' && raw.threadId) {
            serverThreadId = raw.threadId;
          }
          const envelope = (raw.envelope ?? {}) as Record<string, unknown>;
          const inReplyTo = envelope.inReplyTo as string | undefined;
          if (inReplyTo) targetMsgIds.add(inReplyTo);

          // References comes from the fetched header block. parseHeaderBlock
          // unfolds continuation lines, so a long reference chain wrapped over
          // several lines is read whole rather than cut at the first newline.
          if (raw.headers && Buffer.isBuffer(raw.headers)) {
            const rootHeaders = parseHeaderBlock(raw.headers.toString('utf-8'));
            rootHeaders.references
              ?.split(/\s+/)
              .filter(Boolean)
              .forEach((ref) => {
                targetMsgIds.add(ref);
              });
          }
        }
      }

      // Find the messages of the thread.
      //
      // Where the server threads for us, one search by thread id settles it,
      // and it is also more accurate: a reply whose References chain was
      // mangled in transit still carries the right thread id.
      //
      // Otherwise, follow the chain: those carrying one of the collected
      // Message-IDs, and those replying to one — three OR'd searches rather
      // than three per Message-ID.
      let foundUids: Set<number>;
      if (serverThreadId) {
        const threaded = await client.search({ threadId: serverThreadId }, { uid: true });
        foundUids = new Set<number>(Array.isArray(threaded) ? threaded : []);
      } else {
        const wantedIds = Array.from(targetMsgIds);
        const matchedUidGroups = await Promise.all([
          ImapService.searchHeaderAnyOf(client, 'Message-ID', wantedIds),
          ImapService.searchHeaderAnyOf(client, 'References', wantedIds),
          ImapService.searchHeaderAnyOf(client, 'In-Reply-To', wantedIds),
        ]);
        foundUids = new Set<number>(matchedUidGroups.flat());
      }

      if (foundUids.size === 0) {
        return {
          threadId: messageId,
          messages: [],
          participants: [],
          messageCount: 0,
        };
      }

      // Fetch full content for all thread messages
      const uidList = Array.from(foundUids).slice(0, MAX_THREAD_MESSAGES);
      const range = uidList.join(',');
      const messages: Email[] = [];

      // eslint-disable-next-line no-restricted-syntax
      for await (const msg of client.fetch(
        range,
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          headers: true,
        },
        { uid: true },
      )) {
        const raw = msg as unknown as Record<string, unknown>;
        const uid = raw.uid as number;
        messages.push(await messageToEmail(raw, client, uid));
      }

      // Sort chronologically
      messages.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      // Extract unique participants
      const participantMap = new Map<string, EmailAddress>();
      messages.forEach((email) => {
        const addParticipant = (addr: EmailAddress) => {
          const key = addr.address.toLowerCase();
          if (!participantMap.has(key)) {
            participantMap.set(key, addr);
          }
        };
        addParticipant(email.from);
        email.to.forEach(addParticipant);
        email.cc?.forEach(addParticipant);
      });

      return {
        threadId: messageId,
        messages,
        participants: Array.from(participantMap.values()),
        messageCount: messages.length,
      };
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Contact extraction
  // -------------------------------------------------------------------------

  async extractContacts(
    accountName: string,
    options: { mailbox?: string; limit?: number } = {},
  ): Promise<Contact[]> {
    const client = await this.connections.getImapClient(accountName);
    const mailbox = options.mailbox ?? 'INBOX';
    const limit = Math.min(options.limit ?? 100, 500);

    const lock = await client.getMailboxLock(mailbox);
    try {
      // Search for all messages, take the latest N
      const searchResult = await client.search({ all: true }, { uid: true });
      const uids: number[] = Array.isArray(searchResult) ? searchResult : [];

      if (uids.length === 0) return [];

      uids.sort((a, b) => b - a);
      const targetUids = uids.slice(0, limit);
      const range = targetUids.join(',');

      const contactMap = new Map<
        string,
        { name?: string; email: string; frequency: number; lastSeen: Date }
      >();

      // eslint-disable-next-line no-restricted-syntax
      for await (const msg of client.fetch(range, { uid: true, envelope: true }, { uid: true })) {
        const envelope = ((msg as unknown as Record<string, unknown>).envelope ?? {}) as Record<
          string,
          unknown
        >;
        const date = envelope.date ? new Date(envelope.date as string) : new Date();

        const addressLists = [
          envelope.from as { name?: string; address?: string }[] | undefined,
          envelope.to as { name?: string; address?: string }[] | undefined,
          envelope.cc as { name?: string; address?: string }[] | undefined,
        ];

        addressLists.forEach((addrs) => {
          (addrs ?? []).forEach((addr) => {
            if (!addr.address) return;
            const key = addr.address.toLowerCase();
            const existing = contactMap.get(key);
            if (existing) {
              existing.frequency += 1;
              if (date > existing.lastSeen) {
                existing.lastSeen = date;
                if (addr.name) existing.name = addr.name;
              }
            } else {
              contactMap.set(key, {
                name: addr.name ?? undefined,
                email: addr.address,
                frequency: 1,
                lastSeen: date,
              });
            }
          });
        });
      }

      // Sort by frequency descending
      const contacts: Contact[] = Array.from(contactMap.values())
        .sort((a, b) => b.frequency - a.frequency)
        .map((c) => ({
          name: c.name,
          email: c.email,
          frequency: c.frequency,
          lastSeen: c.lastSeen.toISOString(),
        }));

      return contacts;
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Email analytics
  // -------------------------------------------------------------------------

  async getEmailStats(
    accountName: string,
    mailbox: string,
    period: 'day' | 'week' | 'month',
  ): Promise<EmailStats> {
    const client = await this.connections.getImapClient(accountName);

    const now = new Date();
    const since = new Date(now);
    if (period === 'day') since.setDate(since.getDate() - 1);
    else if (period === 'week') since.setDate(since.getDate() - 7);
    else since.setMonth(since.getMonth() - 1);

    const lock = await client.getMailboxLock(mailbox);
    try {
      // Date-range search
      const uids: number[] = await client
        .search({ since }, { uid: true })
        .then((r: unknown) => (Array.isArray(r) ? r : []) as number[]);

      if (uids.length === 0) {
        return {
          period,
          dateRange: {
            from: since.toISOString().split('T')[0],
            to: now.toISOString().split('T')[0],
          },
          totalReceived: 0,
          unreadCount: 0,
          flaggedCount: 0,
          topSenders: [],
          dailyVolume: [],
          hasAttachmentsCount: 0,
          avgPerDay: 0,
        };
      }

      const range = uids.join(',');
      const senderMap = new Map<string, { email: string; name?: string; count: number }>();
      const dailyMap = new Map<string, number>();
      let unread = 0;
      let flagged = 0;
      let withAttachments = 0;

      // eslint-disable-next-line no-restricted-syntax
      for await (const msg of client.fetch(
        range,
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
        },
        { uid: true },
      )) {
        const envelope = ((msg as unknown as Record<string, unknown>).envelope ?? {}) as Record<
          string,
          unknown
        >;
        const flags = ((msg as unknown as Record<string, unknown>).flags ??
          new Set()) as Set<string>;
        const { bodyStructure } = msg as unknown as Record<string, unknown>;

        // Count flags
        if (!flags.has('\\Seen')) unread += 1;
        if (flags.has('\\Flagged')) flagged += 1;
        if (hasAttachments(bodyStructure)) withAttachments += 1;

        // Track sender
        const fromList = (envelope.from ?? []) as {
          name?: string;
          address?: string;
        }[];
        if (fromList.length > 0 && fromList[0].address) {
          const key = fromList[0].address.toLowerCase();
          const existing = senderMap.get(key);
          if (existing) {
            existing.count += 1;
          } else {
            senderMap.set(key, {
              email: fromList[0].address,
              name: fromList[0].name,
              count: 1,
            });
          }
        }

        // Track daily volume
        const date = envelope.date ? new Date(envelope.date as string) : new Date();
        const dayKey = date.toISOString().split('T')[0];
        dailyMap.set(dayKey, (dailyMap.get(dayKey) ?? 0) + 1);
      }

      const topSenders: SenderStat[] = Array.from(senderMap.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      const dailyVolume: DailyVolume[] = Array.from(dailyMap.entries())
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date));

      const days = Math.max(1, dailyVolume.length);

      return {
        period,
        dateRange: {
          from: since.toISOString().split('T')[0],
          to: now.toISOString().split('T')[0],
        },
        totalReceived: uids.length,
        unreadCount: unread,
        flaggedCount: flagged,
        topSenders,
        dailyVolume,
        hasAttachmentsCount: withAttachments,
        avgPerDay: Math.round((uids.length / days) * 10) / 10,
      };
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Quota
  // -------------------------------------------------------------------------

  /**
   * Mailbox counters without scanning the mailbox.
   *
   * STATUS answers the totals directly, and counting today's arrivals needs
   * only the length of a SEARCH result — no envelopes, no body structure. Two
   * round trips, whatever the mailbox holds.
   */
  async getMailboxSnapshot(accountName: string, mailbox = 'INBOX'): Promise<MailboxSnapshot> {
    const client = await this.connections.getImapClient(accountName);
    const safeMailbox = sanitizeMailboxName(mailbox);

    const status = await client.status(safeMailbox, { messages: true, unseen: true });

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const lock = await client.getMailboxLock(safeMailbox);
    let receivedToday = 0;
    try {
      const todayUids = await client.search({ since: startOfToday }, { uid: true });
      receivedToday = Array.isArray(todayUids) ? todayUids.length : 0;
    } finally {
      lock.release();
    }

    return {
      total: status.messages ?? 0,
      unread: status.unseen ?? 0,
      receivedToday,
    };
  }

  async getQuota(accountName: string): Promise<QuotaInfo | null> {
    const client = await this.connections.getImapClient(accountName);
    try {
      const quota = await (
        client as unknown as {
          getQuotaForMailbox: (path: string) => Promise<{
            storage?: { usage?: number; limit?: number };
          } | null>;
        }
      ).getQuotaForMailbox('INBOX');

      if (!quota?.storage?.limit) return null;

      const usedMb = Math.round((quota.storage.usage ?? 0) / 1024);
      const totalMb = Math.round(quota.storage.limit / 1024);
      return {
        usedMb,
        totalMb,
        percentage: totalMb > 0 ? Math.round((usedMb / totalMb) * 100) : 0,
      };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Capabilities
  // -------------------------------------------------------------------------

  async getCapabilities(accountName: string): Promise<string[]> {
    const client = await this.connections.getImapClient(accountName);
    try {
      // ImapFlow exposes capabilities as a Set on the client
      const caps = (client as unknown as Record<string, unknown>).capabilities as
        | Set<string>
        | undefined;
      return caps ? Array.from(caps) : [];
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Calendar part extraction
  // -------------------------------------------------------------------------

  /* eslint-disable no-await-in-loop, no-restricted-syntax -- Sequential IMAP fetch required */
  async getCalendarParts(accountName: string, mailbox: string, emailId: string): Promise<string[]> {
    const client = await this.connections.getImapClient(accountName);
    const lock = await client.getMailboxLock(mailbox);

    try {
      const icsContents: string[] = [];

      // Fetch body structure
      for await (const msg of client.fetch(
        emailId,
        { uid: true, bodyStructure: true },
        { uid: true },
      )) {
        const structure = (msg as unknown as Record<string, unknown>).bodyStructure;
        const parts = this.findCalendarParts(structure);

        // Fetch each calendar part
        for (const partId of parts) {
          for await (const partMsg of client.fetch(
            emailId,
            { uid: true, bodyParts: [partId] },
            { uid: true },
          )) {
            const bodyParts = (partMsg as unknown as Record<string, unknown>).bodyParts as
              | Map<string, Buffer>
              | undefined;
            if (bodyParts) {
              bodyParts.forEach((buf) => {
                icsContents.push(buf.toString('utf-8'));
              });
            }
          }
        }
      }

      return icsContents;
    } finally {
      lock.release();
    }
  }
  /* eslint-enable no-await-in-loop, no-restricted-syntax */

  /**
   * Recursively find body parts with text/calendar content type.
   */
  private findCalendarParts(structure: unknown, prefix = ''): string[] {
    if (!structure || typeof structure !== 'object') return [];
    const s = structure as Record<string, unknown>;
    const parts: string[] = [];

    const type = (s.type as string | undefined)?.toLowerCase() ?? '';
    const subtype = (s.subtype as string | undefined)?.toLowerCase() ?? '';
    const disposition = (s.disposition as string | undefined)?.toLowerCase() ?? '';

    // Check for text/calendar part
    if (type === 'text' && subtype === 'calendar') {
      const partId = s.part as string | undefined;
      if (partId) parts.push(partId);
      else if (prefix) parts.push(prefix);
    }

    // Check for .ics attachment
    if (disposition === 'attachment' && typeof s.dispositionParameters === 'object') {
      const params = s.dispositionParameters as Record<string, string>;
      const filename = params.filename ?? '';
      if (filename.toLowerCase().endsWith('.ics')) {
        const partId = s.part as string | undefined;
        if (partId) parts.push(partId);
        else if (prefix) parts.push(prefix);
      }
    }

    // Recurse into child nodes
    if (Array.isArray(s.childNodes)) {
      s.childNodes.forEach((child: unknown, i: number) => {
        const childPrefix = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
        parts.push(...this.findCalendarParts(child, childPrefix));
      });
    }

    return parts;
  }
}
