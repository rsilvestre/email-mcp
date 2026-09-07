import type { IConnectionManager } from '../connections/types.js';
import type RateLimiter from '../safety/rate-limiter.js';
import type ImapService from './imap.service.js';
import SmtpService from './smtp.service.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockTransport() {
  return {
    sendMail: vi.fn().mockResolvedValue({ messageId: '<test@example.com>' }),
  };
}

function createMockConnectionManager(mockTransport: ReturnType<typeof createMockTransport>) {
  return {
    getAccount: vi.fn().mockReturnValue({
      name: 'test',
      email: 'test@example.com',
      fullName: 'Test User',
      username: 'test@example.com',
      imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
      smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
    }),
    getAccountNames: vi.fn().mockReturnValue(['test']),
    getImapClient: vi.fn(),
    getSmtpTransport: vi.fn().mockResolvedValue(mockTransport),
    closeAll: vi.fn(),
  } satisfies IConnectionManager;
}

function createMockRateLimiter(allowed = true) {
  return {
    tryConsume: vi.fn().mockReturnValue(allowed),
    remaining: vi.fn().mockReturnValue(allowed ? 9 : 0),
  } as unknown as RateLimiter;
}

function createMockImapService() {
  return {
    appendToSent: vi.fn().mockResolvedValue('INBOX.Sent'),
    // sendDraft reads the draft and carries its attachments over, so the
    // fixture needs the shape a real fetchDraft returns.
    fetchDraft: vi.fn().mockResolvedValue({
      email: {
        id: '5',
        subject: 'Draft subject',
        to: [{ address: 'dest@example.com' }],
        bodyText: 'Draft body',
        attachments: [],
      },
      mailbox: 'Drafts',
    }),
    deleteDraft: vi.fn().mockResolvedValue(undefined),
    getEmail: vi.fn().mockResolvedValue({
      id: '1',
      subject: 'Original',
      from: { address: 'sender@example.com' },
      to: [{ address: 'test@example.com' }],
      date: new Date().toISOString(),
      bodyText: 'Original body',
      attachments: [],
    }),
  } as unknown as ImapService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SmtpService', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let rateLimiter: RateLimiter;
  let imapService: ReturnType<typeof createMockImapService>;
  let service: SmtpService;

  beforeEach(() => {
    transport = createMockTransport();
    connections = createMockConnectionManager(transport);
    rateLimiter = createMockRateLimiter(true);
    imapService = createMockImapService();
    service = new SmtpService(connections, rateLimiter, imapService);
  });

  describe('sendEmail', () => {
    it('sends email via SMTP transport', async () => {
      const result = await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(result).toEqual({
        messageId: '<test@example.com>',
        status: 'sent',
        sentCopy: { kind: 'filed', path: 'INBOX.Sent' },
      });
      expect(transport.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: '"Test User" <test@example.com>',
          to: 'recipient@example.com',
          subject: 'Hello',
          text: 'World',
        }),
      );
    });

    it('throws when rate limited', async () => {
      rateLimiter = createMockRateLimiter(false);
      service = new SmtpService(connections, rateLimiter, createMockImapService());

      await expect(
        service.sendEmail('test', {
          to: ['recipient@example.com'],
          subject: 'Hello',
          body: 'World',
        }),
      ).rejects.toThrow('Rate limit exceeded');

      expect(transport.sendMail).not.toHaveBeenCalled();
    });

    it('includes CC and BCC when provided', async () => {
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'Test',
        body: 'Body',
        cc: ['cc1@example.com', 'cc2@example.com'],
        bcc: ['bcc@example.com'],
      });

      expect(transport.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          cc: 'cc1@example.com, cc2@example.com',
          bcc: 'bcc@example.com',
        }),
      );
    });

    it('sends as HTML when html=true', async () => {
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'HTML Test',
        body: '<h1>Hello</h1>',
        html: true,
      });

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.html).toBe('<h1>Hello</h1>');
      expect(call.text).toBeUndefined();
    });

    it('decodes and sends base64 attachments', async () => {
      await service.sendEmail('test', {
        to: ['a@example.com'],
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

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.attachments).toEqual([
        { filename: 'note.txt', content: Buffer.from('hello'), contentType: 'text/plain' },
      ]);
    });

    it('rejects invalid attachments before sending', async () => {
      await expect(
        service.sendEmail('test', {
          to: ['a@example.com'],
          subject: 'Bad attachment',
          body: 'oops',
          attachments: [{ filename: 'note.txt' }],
        }),
      ).rejects.toThrow('exactly one of "content"');

      expect(transport.sendMail).not.toHaveBeenCalled();
    });
  });

  describe('forwardEmail', () => {
    function createMockImapServiceWithEmail(
      attachments: { filename: string; mimeType: string; size: number }[],
    ) {
      return {
        getEmail: vi.fn().mockResolvedValue({
          id: '1',
          subject: 'Original',
          from: { address: 'sender@example.com' },
          to: [{ address: 'test@example.com' }],
          date: new Date().toISOString(),
          bodyText: 'Original body',
          attachments,
        }),
        downloadAttachment: vi.fn().mockResolvedValue({
          filename: 'report.pdf',
          mimeType: 'application/pdf',
          size: 3,
          contentBase64: Buffer.from('pdf').toString('base64'),
        }),
        // Every send path now files a Sent copy through dispatch().
        appendToSent: vi.fn().mockResolvedValue('INBOX.Sent'),
      } as unknown as ImapService;
    }

    it('does not include original attachments by default', async () => {
      const mockImap = createMockImapServiceWithEmail([
        { filename: 'report.pdf', mimeType: 'application/pdf', size: 3 },
      ]);
      service = new SmtpService(connections, rateLimiter, mockImap);

      await service.forwardEmail('test', { emailId: '1', to: ['dest@example.com'] });

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.attachments).toEqual([]);
      expect(mockImap.downloadAttachment).not.toHaveBeenCalled();
    });

    it('re-attaches original attachments when includeOriginalAttachments is true', async () => {
      const mockImap = createMockImapServiceWithEmail([
        { filename: 'report.pdf', mimeType: 'application/pdf', size: 3 },
      ]);
      service = new SmtpService(connections, rateLimiter, mockImap);

      await service.forwardEmail('test', {
        emailId: '1',
        to: ['dest@example.com'],
        includeOriginalAttachments: true,
      });

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.attachments).toEqual([
        { filename: 'report.pdf', content: Buffer.from('pdf'), contentType: 'application/pdf' },
      ]);
    });

    it('combines original and user-supplied attachments', async () => {
      const mockImap = createMockImapServiceWithEmail([
        { filename: 'report.pdf', mimeType: 'application/pdf', size: 3 },
      ]);
      service = new SmtpService(connections, rateLimiter, mockImap);

      await service.forwardEmail('test', {
        emailId: '1',
        to: ['dest@example.com'],
        includeOriginalAttachments: true,
        attachments: [{ filename: 'note.txt', content: Buffer.from('hi').toString('base64') }],
      });

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.attachments).toHaveLength(2);
      expect(call.attachments[0].filename).toBe('report.pdf');
      expect(call.attachments[1].filename).toBe('note.txt');
    });
  });

  describe('sendDraft', () => {
    function createMockImapServiceWithDraft(
      attachments: { filename: string; mimeType: string; size: number }[],
    ) {
      return {
        fetchDraft: vi.fn().mockResolvedValue({
          email: {
            id: '5',
            subject: 'Draft subject',
            to: [{ address: 'dest@example.com' }],
            bodyText: 'Draft body',
            attachments,
          },
          mailbox: 'Drafts',
        }),
        downloadAttachment: vi.fn().mockResolvedValue({
          filename: 'invoice.pdf',
          mimeType: 'application/pdf',
          size: 3,
          contentBase64: Buffer.from('pdf').toString('base64'),
        }),
        deleteDraft: vi.fn().mockResolvedValue(undefined),
        appendToSent: vi.fn().mockResolvedValue('INBOX.Sent'),
      } as unknown as ImapService;
    }

    it('carries the draft attachments over when sending', async () => {
      const mockImap = createMockImapServiceWithDraft([
        { filename: 'invoice.pdf', mimeType: 'application/pdf', size: 3 },
      ]);
      service = new SmtpService(connections, rateLimiter, mockImap);

      await service.sendDraft('test', 5);

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.attachments).toEqual([
        { filename: 'invoice.pdf', content: Buffer.from('pdf'), contentType: 'application/pdf' },
      ]);
      expect(mockImap.deleteDraft).toHaveBeenCalledWith('test', 5, 'Drafts');
    });

    it('sends with no attachments when the draft has none', async () => {
      const mockImap = createMockImapServiceWithDraft([]);
      service = new SmtpService(connections, rateLimiter, mockImap);

      await service.sendDraft('test', 5);

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.attachments).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Sent copy
  // -----------------------------------------------------------------------

  describe('filing a copy in Sent', () => {
    it('files every sent message and reports the folder', async () => {
      const result = await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(imapService.appendToSent).toHaveBeenCalledOnce();
      expect(result.sentCopy).toEqual({ kind: 'filed', path: 'INBOX.Sent' });
    });

    it('files a copy carrying the Message-ID that SMTP returned', async () => {
      transport.sendMail.mockResolvedValue({ messageId: '<real-id@example.com>' });

      await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      const [, raw] = (imapService.appendToSent as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, Buffer];
      expect(raw.toString()).toContain('Message-ID: <real-id@example.com>');
      expect(raw.toString()).toContain('Subject: Hello');
    });

    it('reports a send as sent even when filing the copy fails', async () => {
      (imapService.appendToSent as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('NO [TRYCREATE] Mailbox does not exist'),
      );

      const result = await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(result.status).toBe('sent');
      expect(result.messageId).toBe('<test@example.com>');
      expect(result.sentCopy).toEqual({
        kind: 'failed',
        error: expect.stringContaining('Mailbox does not exist'),
      });
    });

    // The guard returns a bare null where the server files sent mail itself.
    // Before the union that was indistinguishable from a copy that failed.
    it('reports the copy as skipped when the server files it itself', async () => {
      (imapService.appendToSent as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(result.status).toBe('sent');
      expect(result.sentCopy).toEqual({ kind: 'skipped' });
    });

    it('files a copy for replies, forwards and drafts too, not only plain sends', async () => {
      const imap = imapService as unknown as {
        appendToSent: ReturnType<typeof vi.fn>;
        getEmail: ReturnType<typeof vi.fn>;
        fetchDraft: ReturnType<typeof vi.fn>;
        deleteDraft: ReturnType<typeof vi.fn>;
      };
      imap.getEmail = vi.fn().mockResolvedValue({
        from: { address: 'them@example.com' },
        to: [{ address: 'test@example.com' }],
        subject: 'Original',
        messageId: '<orig@example.com>',
        date: '2026-01-01',
        bodyText: 'body',
        attachments: [],
      });
      imap.fetchDraft = vi.fn().mockResolvedValue({
        email: {
          to: [{ address: 'recipient@example.com' }],
          subject: 'Draft',
          bodyText: 'draft body',
          attachments: [],
        },
        mailbox: 'INBOX.Drafts',
      });
      imap.deleteDraft = vi.fn().mockResolvedValue(undefined);

      await service.replyToEmail('test', { emailId: '1', body: 'reply' });
      await service.forwardEmail('test', { emailId: '1', to: ['other@example.com'] });
      await service.sendDraft('test', 1);

      expect(imap.appendToSent).toHaveBeenCalledTimes(3);
    });
  });

  describe('send_draft and the last remaining copy', () => {
    function mockDraft() {
      const imap = imapService as unknown as {
        appendToSent: ReturnType<typeof vi.fn>;
        fetchDraft: ReturnType<typeof vi.fn>;
        deleteDraft: ReturnType<typeof vi.fn>;
      };
      imap.fetchDraft = vi.fn().mockResolvedValue({
        email: {
          to: [{ address: 'recipient@example.com' }],
          subject: 'D',
          bodyText: 'b',
          attachments: [],
        },
        mailbox: 'INBOX.Drafts',
      });
      imap.deleteDraft = vi.fn().mockResolvedValue(undefined);
      return imap;
    }

    it('removes the draft once the copy is filed', async () => {
      const imap = mockDraft();

      const result = await service.sendDraft('test', 1);

      expect(imap.deleteDraft).toHaveBeenCalledOnce();
      expect(result.draft).toBe('removed');
    });

    // Without the copy there is nothing left but the draft. Deleting it here is
    // how sending a draft used to destroy the message outright.
    it('keeps the draft when the Sent copy failed', async () => {
      const imap = mockDraft();
      imap.appendToSent.mockRejectedValue(new Error('NO [TRYCREATE] Mailbox does not exist'));

      const result = await service.sendDraft('test', 1);

      expect(imap.deleteDraft).not.toHaveBeenCalled();
      expect(result.draft).toBe('kept');
      expect(result.sentCopy.kind).toBe('failed');
    });

    it('removes the draft when the copy was skipped on purpose', async () => {
      const imap = mockDraft();
      imap.appendToSent.mockResolvedValue(null);

      const result = await service.sendDraft('test', 1);

      expect(imap.deleteDraft).toHaveBeenCalledOnce();
      expect(result.draft).toBe('removed');
    });
  });
});
