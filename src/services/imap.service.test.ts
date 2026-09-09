import type { IConnectionManager } from '../connections/types.js';
import ImapService from './imap.service.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockImapClient() {
  const releaseFn = vi.fn();
  return {
    usable: true,
    getMailboxLock: vi.fn().mockResolvedValue({ release: releaseFn }),
    list: vi.fn().mockResolvedValue([]),
    status: vi.fn().mockResolvedValue({ messages: 5, unseen: 2 }),
    fetch: vi.fn().mockReturnValue((async function* fetchMock() {})()),
    search: vi.fn().mockResolvedValue([]),
    messageMove: vi.fn().mockResolvedValue(true),
    messageDelete: vi.fn().mockResolvedValue(true),
    messageFlagsAdd: vi.fn().mockResolvedValue(true),
    messageFlagsRemove: vi.fn().mockResolvedValue(true),
    append: vi.fn().mockResolvedValue({ uid: 42 }),
    fetchOne: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockResolvedValue(undefined),
    capabilities: new Set<string>(),
    _releaseFn: releaseFn,
  };
}

function createMockConnectionManager(mockClient: ReturnType<typeof createMockImapClient>) {
  return {
    getAccount: vi.fn().mockReturnValue({
      name: 'test',
      email: 'test@example.com',
      username: 'test@example.com',
      imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
      smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
    }),
    getAccountNames: vi.fn().mockReturnValue(['test']),
    getImapClient: vi.fn().mockResolvedValue(mockClient),
    getSmtpTransport: vi.fn(),
    closeAll: vi.fn(),
  } satisfies IConnectionManager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ImapService', () => {
  let client: ReturnType<typeof createMockImapClient>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let service: ImapService;

  beforeEach(() => {
    client = createMockImapClient();
    connections = createMockConnectionManager(client);
    service = new ImapService(connections);
  });

  // -----------------------------------------------------------------------
  // listMailboxes
  // -----------------------------------------------------------------------

  describe('listMailboxes', () => {
    it('returns mailbox list with message counts', async () => {
      client.list.mockResolvedValue([
        { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' },
        { name: 'Sent', path: 'Sent', specialUse: '\\Sent' },
      ]);
      client.status.mockResolvedValue({ messages: 10, unseen: 3 });

      const result = await service.listMailboxes('test');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        name: 'INBOX',
        path: 'INBOX',
        specialUse: '\\Inbox',
        totalMessages: 10,
        unseenMessages: 3,
      });
      expect(result[1]).toEqual({
        name: 'Sent',
        path: 'Sent',
        specialUse: '\\Sent',
        totalMessages: 10,
        unseenMessages: 3,
      });
      expect(client.status).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // moveEmail
  // -----------------------------------------------------------------------

  describe('moveEmail', () => {
    it('moves email between mailboxes', async () => {
      // assertRealMailbox calls client.list() internally
      client.list.mockResolvedValue([{ name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' }]);

      await service.moveEmail('test', '42', 'INBOX', 'Archive');

      expect(client.getMailboxLock).toHaveBeenCalledWith('INBOX');
      expect(client.messageMove).toHaveBeenCalledWith('42', 'Archive', { uid: true });
      expect(client._releaseFn).toHaveBeenCalled();
    });

    it('calls sanitizeMailboxName on inputs', async () => {
      client.list.mockResolvedValue([]);

      // Passing valid names — sanitize should pass them through without error
      await service.moveEmail('test', '1', 'INBOX', 'Sent');

      expect(client.messageMove).toHaveBeenCalledWith('1', 'Sent', { uid: true });
    });
  });

  // -----------------------------------------------------------------------
  // deleteEmail
  // -----------------------------------------------------------------------

  describe('deleteEmail', () => {
    it('permanently deletes when permanent=true', async () => {
      await service.deleteEmail('test', '99', 'INBOX', true);

      expect(client.messageDelete).toHaveBeenCalledWith('99', { uid: true });
      expect(client.messageMove).not.toHaveBeenCalled();
      expect(client._releaseFn).toHaveBeenCalled();
    });

    it('moves to trash when permanent=false', async () => {
      // assertRealMailbox + trash detection both call client.list()
      client.list.mockResolvedValue([
        { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' },
        { name: 'Trash', path: 'Trash', specialUse: '\\Trash' },
      ]);

      await service.deleteEmail('test', '99', 'INBOX', false);

      expect(client.messageDelete).not.toHaveBeenCalled();
      expect(client.messageMove).toHaveBeenCalledWith('99', 'Trash', { uid: true });
      expect(client._releaseFn).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // setFlags
  // -----------------------------------------------------------------------

  describe('setFlags', () => {
    it('adds Seen flag for read action', async () => {
      await service.setFlags('test', '10', 'INBOX', 'read');

      expect(client.messageFlagsAdd).toHaveBeenCalledWith('10', ['\\Seen'], { uid: true });
      expect(client.messageFlagsRemove).not.toHaveBeenCalled();
    });

    it('removes Seen flag for unread action', async () => {
      await service.setFlags('test', '10', 'INBOX', 'unread');

      expect(client.messageFlagsRemove).toHaveBeenCalledWith('10', ['\\Seen'], { uid: true });
      expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    });

    it('adds Flagged flag for flag action', async () => {
      await service.setFlags('test', '10', 'INBOX', 'flag');

      expect(client.messageFlagsAdd).toHaveBeenCalledWith('10', ['\\Flagged'], { uid: true });
    });
  });

  // -----------------------------------------------------------------------
  // appendToSent
  // -----------------------------------------------------------------------

  describe('appendToSent', () => {
    it('files the copy in the folder the server flags as \\Sent', async () => {
      client.list.mockResolvedValue([
        { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' },
        { name: 'Drafts', path: 'INBOX.draft', specialUse: '\\Drafts' },
        { name: 'Sent', path: 'INBOX.Sent Messages', specialUse: '\\Sent' },
      ]);

      const path = await service.appendToSent('test', Buffer.from('raw message'));

      expect(path).toBe('INBOX.Sent Messages');
      expect(client.append).toHaveBeenCalledWith(
        'INBOX.Sent Messages',
        Buffer.from('raw message'),
        ['\\Seen'],
      );
    });

    it('falls back to "Sent" when the server flags no folder', async () => {
      client.list.mockResolvedValue([{ name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' }]);

      const path = await service.appendToSent('test', Buffer.from('raw'));

      expect(path).toBe('Sent');
    });

    it("prefers the configured sent_mailbox over the client's guess", async () => {
      connections.getAccount.mockReturnValue({
        name: 'test',
        email: 'test@example.com',
        username: 'test@example.com',
        sentMailbox: 'INBOX.Sent Messages',
        imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
        smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
      });
      client.list.mockResolvedValue([
        { name: 'Sent', path: 'INBOX.INBOX.Sent', specialUse: '\\Sent' },
      ]);

      const path = await service.appendToSent('test', Buffer.from('raw'));

      expect(path).toBe('INBOX.Sent Messages');
      expect(client.append).toHaveBeenCalledWith('INBOX.Sent Messages', expect.any(Buffer), [
        '\\Seen',
      ]);
      // the override settles it, so there is nothing to look up
      expect(client.list).not.toHaveBeenCalled();
    });

    // Gmail files SMTP sends into Sent Mail itself; appending on top of that
    // gives the user every sent message twice.
    it('skips the copy on a server that files sent mail itself', async () => {
      const gmailClient = createMockImapClient();
      gmailClient.capabilities.add('X-GM-EXT-1');
      const svc = new ImapService(createMockConnectionManager(gmailClient) as never);

      const path = await svc.appendToSent('test', Buffer.from('raw'));

      expect(path).toBeNull();
      expect(gmailClient.append).not.toHaveBeenCalled();
    });

    it('files the copy anyway when the account asks for it explicitly', async () => {
      const gmailClient = createMockImapClient();
      gmailClient.capabilities.add('X-GM-EXT-1');
      const manager = createMockConnectionManager(gmailClient);
      manager.getAccount = vi.fn().mockReturnValue({ name: 'test', saveToSent: true });
      const svc = new ImapService(manager as never);

      expect(await svc.appendToSent('test', Buffer.from('raw'))).not.toBeNull();
      expect(gmailClient.append).toHaveBeenCalledOnce();
    });

    it('honours save_to_sent = false on a server that does not file it', async () => {
      const plainClient = createMockImapClient();
      const manager = createMockConnectionManager(plainClient);
      manager.getAccount = vi.fn().mockReturnValue({ name: 'test', saveToSent: false });
      const svc = new ImapService(manager as never);

      expect(await svc.appendToSent('test', Buffer.from('raw'))).toBeNull();
      expect(plainClient.append).not.toHaveBeenCalled();
    });

    it('marks the copy read so it does not show up as unread mail', async () => {
      client.list.mockResolvedValue([{ name: 'Sent', path: 'Sent', specialUse: '\\Sent' }]);

      await service.appendToSent('test', Buffer.from('raw'));

      expect(client.append).toHaveBeenCalledWith('Sent', expect.any(Buffer), ['\\Seen']);
    });
  });

  // -----------------------------------------------------------------------
  // saveDraft
  // -----------------------------------------------------------------------

  describe('saveDraft', () => {
    it('appends a plain RFC822 message when there are no attachments', async () => {
      const result = await service.saveDraft('test', {
        to: ['dest@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(result).toEqual({ id: 42, mailbox: 'Drafts' });
      const [mailbox, raw, flags] = client.append.mock.calls[0];
      expect(mailbox).toBe('Drafts');
      expect(flags).toEqual(['\\Draft', '\\Seen']);
      const text = (raw as Buffer).toString('utf-8');
      expect(text).toContain('Subject: Hello');
      expect(text).toContain('To: dest@example.com');
      expect(text).toContain('World');
    });

    it('builds a multipart MIME message with the attachment when attachments are provided', async () => {
      const result = await service.saveDraft('test', {
        to: ['dest@example.com'],
        subject: 'With attachment',
        body: 'See attached',
        attachments: [
          {
            filename: 'note.txt',
            content: Buffer.from('hello').toString('base64'),
            contentType: 'text/plain',
          },
        ],
      });

      expect(result).toEqual({ id: 42, mailbox: 'Drafts' });
      const [, raw] = client.append.mock.calls[0];
      const text = (raw as Buffer).toString('utf-8');
      expect(text).toContain('multipart/mixed');
      expect(text).toContain('Content-Disposition: attachment; filename=note.txt');
      expect(text).toContain(Buffer.from('hello').toString('base64'));
      expect(text).toContain('See attached');
    });

    it('rejects invalid attachments before appending', async () => {
      await expect(
        service.saveDraft('test', {
          to: ['dest@example.com'],
          subject: 'Bad',
          body: 'oops',
          attachments: [{ filename: 'note.txt' }],
        }),
      ).rejects.toThrow('exactly one of "content"');

      expect(client.append).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// getEmail body retrieval
// ---------------------------------------------------------------------------

describe('ImapService.getEmail body retrieval', () => {
  let client: ReturnType<typeof createMockImapClient>;
  let service: ImapService;

  /** A downloaded part, shaped the way imapflow returns one. */
  function downloadedPart(body: string) {
    const buffer = Buffer.from(body, 'utf-8');
    async function* streamPart() {
      yield buffer;
    }
    return { content: streamPart() };
  }

  const headerBlock = Buffer.from(
    ['From: sender@example.com', 'Subject: Devis', 'References: <a@x> <b@x>', ''].join('\r\n'),
  );

  function respondWith(bodyStructure: unknown) {
    client.fetchOne.mockResolvedValue({
      uid: 7,
      envelope: { messageId: '<c@x>', cc: [], bcc: [] },
      flags: new Set<string>(),
      bodyStructure,
      headers: headerBlock,
    });
  }

  beforeEach(() => {
    client = createMockImapClient();
    service = new ImapService(createMockConnectionManager(client));
  });

  it('fetches headers rather than the whole message', async () => {
    respondWith({ type: 'text/plain', encoding: '7bit' });
    client.download.mockResolvedValue(downloadedPart('bonjour'));

    await service.getEmail('test', '7', 'INBOX');

    const fetchOptions = client.fetchOne.mock.calls[0]?.[1] as Record<string, unknown>;
    // BODY.PEEK[] would drag every attachment down to display the text.
    expect(fetchOptions.source).toBeUndefined();
    expect(fetchOptions.headers).toBe(true);
    expect(fetchOptions.bodyStructure).toBe(true);
  });

  it('downloads the body exactly once', async () => {
    respondWith({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', encoding: '7bit' },
        { part: '2', type: 'application/pdf', disposition: 'attachment' },
      ],
    });
    client.download.mockResolvedValue(downloadedPart('le devis est joint'));

    const email = await service.getEmail('test', '7', 'INBOX');

    // The body used to be parsed out of the full source and then downloaded
    // again unconditionally, so every read paid for two overlapping transfers.
    expect(client.download).toHaveBeenCalledTimes(1);
    expect(client.download.mock.calls[0]?.[1]).toBe('1');
    expect(email.bodyText).toBe('le devis est joint');
  });

  it('does not mistake the attachment for the body', async () => {
    respondWith({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', encoding: '7bit' },
        { part: '2', type: 'text/plain', encoding: 'base64', disposition: 'attachment' },
      ],
    });
    client.download.mockResolvedValue(downloadedPart('message'));

    await service.getEmail('test', '7', 'INBOX');

    expect(client.download.mock.calls[0]?.[1]).toBe('1');
  });

  it('prefers the plain alternative over the HTML one', async () => {
    respondWith({
      type: 'multipart/alternative',
      childNodes: [
        { part: '1', type: 'text/plain', encoding: '7bit' },
        { part: '2', type: 'text/html', encoding: '7bit' },
      ],
    });
    client.download.mockResolvedValue(downloadedPart('version texte'));

    const email = await service.getEmail('test', '7', 'INBOX');

    expect(client.download).toHaveBeenCalledTimes(1);
    expect(email.bodyText).toBe('version texte');
    expect(email.bodyHtml).toBeUndefined();
  });

  it('reports an HTML-only body as HTML', async () => {
    respondWith({ type: 'text/html', encoding: '7bit' });
    client.download.mockResolvedValue(downloadedPart('<p>bonjour</p>'));

    const email = await service.getEmail('test', '7', 'INBOX');

    // Assigning this to bodyText, as the old path did, defeated format:'text' —
    // it had no way to know the content needed stripping.
    expect(email.bodyHtml).toBe('<p>bonjour</p>');
    expect(email.bodyText).toBeUndefined();
  });

  it('decodes base64 in a non-UTF-8 charset', async () => {
    respondWith({
      type: 'text/plain',
      encoding: 'base64',
      parameters: { charset: 'iso-8859-1' },
    });
    client.download.mockResolvedValue(
      downloadedPart(Buffer.from('café crème', 'latin1').toString('base64')),
    );

    const email = await service.getEmail('test', '7', 'INBOX');

    expect(email.bodyText).toBe('café crème');
  });

  it('decodes quoted-printable', async () => {
    respondWith({ type: 'text/plain', encoding: 'quoted-printable' });
    client.download.mockResolvedValue(downloadedPart('caf=C3=A9 =\r\ncr=C3=A8me'));

    const email = await service.getEmail('test', '7', 'INBOX');

    expect(email.bodyText).toBe('café crème');
  });

  it('skips the download when the message has no text part', async () => {
    respondWith({
      type: 'multipart/mixed',
      childNodes: [{ part: '1', type: 'application/pdf', disposition: 'attachment' }],
    });

    const email = await service.getEmail('test', '7', 'INBOX');

    expect(client.download).not.toHaveBeenCalled();
    expect(email.bodyText).toBeUndefined();
    expect(email.attachments).toHaveLength(1);
  });

  it('still returns the message when the body download fails', async () => {
    respondWith({ type: 'text/plain', encoding: '7bit' });
    client.download.mockRejectedValue(new Error('NO [CANNOT] Invalid section'));

    const email = await service.getEmail('test', '7', 'INBOX');

    expect(email.bodyText).toBeUndefined();
    expect(email.headers.subject).toBe('Devis');
  });

  it('reads References from the unfolded header block', async () => {
    respondWith({ type: 'text/plain', encoding: '7bit' });
    client.download.mockResolvedValue(downloadedPart('x'));

    const email = await service.getEmail('test', '7', 'INBOX');

    expect(email.references).toEqual(['<a@x>', '<b@x>']);
  });
});

// ---------------------------------------------------------------------------
// findEmailFolder
// ---------------------------------------------------------------------------

describe('ImapService.findEmailFolder', () => {
  let client: ReturnType<typeof createMockImapClient>;
  let service: ImapService;

  /** Mailboxes as client.list() returns them, in an unhelpful order. */
  const mailboxes = [
    { path: 'Archives2019', listed: true, flags: new Set<string>() },
    { path: 'Klakedelle', listed: true, flags: new Set<string>() },
    { path: 'Sent', listed: true, flags: new Set<string>(), specialUse: '\\Sent' },
    { path: 'INBOX', listed: true, flags: new Set<string>() },
    { path: 'Travaux', listed: true, flags: new Set<string>() },
  ];

  beforeEach(() => {
    client = createMockImapClient();
    service = new ImapService(createMockConnectionManager(client));
    client.fetchOne.mockResolvedValue({
      headers: Buffer.from('Message-ID: <target@example.com>\r\n'),
    });
    client.list.mockResolvedValue(mailboxes);
  });

  /** Make the Message-ID search hit in exactly one mailbox. */
  function messageLivesIn(path: string) {
    let currentMailbox = '';
    client.getMailboxLock.mockImplementation(async (mailboxPath: string) => {
      currentMailbox = mailboxPath;
      return { release: vi.fn() };
    });
    client.search.mockImplementation(async () => (currentMailbox === path ? [42] : []));
  }

  it('searches INBOX before any other folder', async () => {
    messageLivesIn('INBOX');

    const result = await service.findEmailFolder('test', '42', 'INBOX');

    expect(result.folders).toEqual(['INBOX']);
    // One SELECT and one SEARCH, not one per folder.
    expect(client.search).toHaveBeenCalledTimes(1);
  });

  it('stops as soon as a folder matches', async () => {
    messageLivesIn('Sent');

    const result = await service.findEmailFolder('test', '42', 'INBOX');

    expect(result.folders).toEqual(['Sent']);
    // INBOX then Sent — the three remaining folders are never selected, which
    // is the whole point: header SEARCH is an unindexed scan per folder.
    expect(client.search).toHaveBeenCalledTimes(2);
  });

  it('still finds a message in an ordinary folder', async () => {
    messageLivesIn('Klakedelle');

    const result = await service.findEmailFolder('test', '42', 'INBOX');

    expect(result.folders).toEqual(['Klakedelle']);
  });

  it('reports no folder when nothing matches', async () => {
    messageLivesIn('nowhere');

    const result = await service.findEmailFolder('test', '42', 'INBOX');

    expect(result.folders).toEqual([]);
    expect(result.messageId).toBe('<target@example.com>');
  });

  it('keeps searching past a folder it cannot select', async () => {
    let currentMailbox = '';
    client.getMailboxLock.mockImplementation(async (mailboxPath: string) => {
      currentMailbox = mailboxPath;
      // Sent is searched second, before the match — an unselectable folder
      // there must not abandon the hunt.
      if (mailboxPath === 'Sent') throw new Error('NO [SERVERBUG] cannot select');
      return { release: vi.fn() };
    });
    client.search.mockImplementation(async () => (currentMailbox === 'Klakedelle' ? [42] : []));

    const result = await service.findEmailFolder('test', '42', 'INBOX');

    expect(result.folders).toEqual(['Klakedelle']);
  });
});

// ---------------------------------------------------------------------------
// hasAttachment filtering
// ---------------------------------------------------------------------------

describe('ImapService hasAttachment filtering', () => {
  let client: ReturnType<typeof createMockImapClient>;
  let service: ImapService;

  /** A bodyStructure that does or does not carry an attachment. */
  function structureFor(uid: number, withAttachment: boolean) {
    return withAttachment
      ? {
          type: 'multipart/mixed',
          childNodes: [
            { part: '1', type: 'text/plain' },
            { part: '2', type: 'application/pdf', disposition: 'attachment' },
          ],
        }
      : { type: 'text/plain', part: String(uid) };
  }

  /**
   * A mailbox of `size` messages where every `everyNth` message has an
   * attachment, recording which UID ranges the service asked about.
   */
  function mailboxOf(size: number, everyNth: number) {
    const uids = Array.from({ length: size }, (_, index) => index + 1);
    const fetchedRanges: string[] = [];

    client.search.mockResolvedValue(uids);
    client.fetch.mockImplementation((range: string, options: Record<string, unknown>) => {
      const requested = range.split(',').map(Number);
      // Only the structure probe is of interest; the page fetch asks for
      // envelopes too and is left alone.
      async function* structures() {
        for (const uid of requested) {
          yield { uid, bodyStructure: structureFor(uid, uid % everyNth === 0) };
        }
      }
      async function* page() {
        for (const uid of requested) {
          yield {
            uid,
            envelope: { date: new Date('2026-01-01').toISOString(), from: [], to: [] },
            flags: new Set<string>(),
            bodyStructure: structureFor(uid, uid % everyNth === 0),
          };
        }
      }
      if (options.bodyStructure === true && options.envelope === undefined) {
        fetchedRanges.push(range);
        return structures();
      }
      return page();
    });

    return { fetchedRanges };
  }

  beforeEach(() => {
    client = createMockImapClient();
    service = new ImapService(createMockConnectionManager(client));
  });

  it('inspects only enough messages to fill the page', async () => {
    // 2000 messages, every 2nd carries an attachment: one 200-UID batch already
    // yields 100 matches, far more than a 20-row page needs.
    const { fetchedRanges } = mailboxOf(2000, 2);

    const result = await service.listEmails('test', { hasAttachment: true, pageSize: 20 });

    expect(result.items).toHaveLength(20);
    // Previously this fetched BODYSTRUCTURE for all 2000 UIDs before slicing.
    expect(fetchedRanges).toHaveLength(1);
    expect(fetchedRanges[0]?.split(',')).toHaveLength(200);
  });

  it('marks the total as a lower bound when it stopped early', async () => {
    mailboxOf(2000, 2);

    const result = await service.listEmails('test', { hasAttachment: true, pageSize: 20 });

    expect(result.totalIsLowerBound).toBe(true);
    expect(result.hasMore).toBe(true);
  });

  it('reports an exact total when the whole set was examined', async () => {
    // 50 messages, every 5th has an attachment: 10 matches, all found in the
    // first batch, so nothing is left unexamined.
    mailboxOf(50, 5);

    const result = await service.listEmails('test', { hasAttachment: true, pageSize: 20 });

    expect(result.total).toBe(10);
    expect(result.totalIsLowerBound).toBeUndefined();
    expect(result.hasMore).toBe(false);
  });

  it('keeps scanning across batches to reach a later page', async () => {
    // Attachments are rare, so one batch cannot fill page 2.
    const { fetchedRanges } = mailboxOf(600, 20);

    const result = await service.listEmails('test', {
      hasAttachment: true,
      page: 2,
      pageSize: 5,
    });

    expect(fetchedRanges.length).toBeGreaterThan(1);
    expect(result.items).toHaveLength(5);
  });

  it('returns newest first', async () => {
    mailboxOf(400, 2);

    const result = await service.listEmails('test', { hasAttachment: true, pageSize: 5 });

    const returnedUids = result.items.map((item) => Number(item.id));
    expect(returnedUids).toEqual([...returnedUids].sort((a, b) => b - a));
  });

  it('finds messages without attachments when asked for the inverse', async () => {
    mailboxOf(400, 2);

    const result = await service.listEmails('test', { hasAttachment: false, pageSize: 5 });

    expect(result.items).toHaveLength(5);
    expect(result.items.every((item) => !item.hasAttachments)).toBe(true);
  });

  it('does not probe structure at all without the filter', async () => {
    const { fetchedRanges } = mailboxOf(400, 2);

    await service.listEmails('test', { pageSize: 20 });

    expect(fetchedRanges).toHaveLength(0);
  });

  it('applies the same batching to search_emails', async () => {
    const { fetchedRanges } = mailboxOf(2000, 2);

    const result = await service.searchEmails('test', 'facture', {
      hasAttachment: true,
      pageSize: 20,
    });

    expect(fetchedRanges).toHaveLength(1);
    expect(result.items).toHaveLength(20);
  });
});
