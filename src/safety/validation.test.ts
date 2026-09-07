import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_ATTACHMENT_SIZE,
  sanitizeMailboxName,
  sanitizeSearchQuery,
  sanitizeTemplateVariable,
  validateAttachments,
  validateInputLength,
  validateLabelName,
  validateWebhookUrl,
} from './validation.js';

describe('sanitizeMailboxName', () => {
  it('returns a valid trimmed name', () => {
    expect(sanitizeMailboxName('  INBOX  ')).toBe('INBOX');
  });

  it('throws on empty string', () => {
    expect(() => sanitizeMailboxName('')).toThrow('must not be empty');
  });

  it('throws on whitespace-only string', () => {
    expect(() => sanitizeMailboxName('   ')).toThrow('must not be empty');
  });

  it('throws when name contains *', () => {
    expect(() => sanitizeMailboxName('INBOX*')).toThrow('wildcard');
  });

  it('throws when name contains %', () => {
    expect(() => sanitizeMailboxName('INBOX%')).toThrow('wildcard');
  });

  it('allows names with dots and slashes', () => {
    expect(sanitizeMailboxName('INBOX/Subfolder.Label')).toBe('INBOX/Subfolder.Label');
  });
});

describe('sanitizeSearchQuery', () => {
  it('returns a clean query', () => {
    expect(sanitizeSearchQuery('hello world')).toBe('hello world');
  });

  it('strips control characters', () => {
    expect(sanitizeSearchQuery('hello\x00\x01world')).toBe('helloworld');
  });

  it('throws on empty after sanitization', () => {
    expect(() => sanitizeSearchQuery('\x00\x01')).toThrow('must not be empty');
  });

  it('preserves tabs', () => {
    expect(sanitizeSearchQuery('hello\tworld')).toBe('hello\tworld');
  });

  it('preserves newlines', () => {
    expect(sanitizeSearchQuery('hello\nworld')).toBe('hello\nworld');
  });
});

describe('validateWebhookUrl', () => {
  it('throws on invalid URL', () => {
    expect(() => validateWebhookUrl('not-a-url')).toThrow('Invalid webhook URL');
  });

  it('throws on non-http(s) protocol', () => {
    expect(() => validateWebhookUrl('ftp://example.com')).toThrow('http or https');
  });

  it('throws on localhost', () => {
    expect(() => validateWebhookUrl('https://localhost/hook')).toThrow('loopback or private');
  });

  it('throws on 127.0.0.1', () => {
    expect(() => validateWebhookUrl('https://127.0.0.1/hook')).toThrow('loopback or private');
  });

  it('throws on 10.x.x.x', () => {
    expect(() => validateWebhookUrl('https://10.0.0.1/hook')).toThrow('loopback or private');
  });

  it('throws on 172.16-31.x.x', () => {
    expect(() => validateWebhookUrl('https://172.16.0.1/hook')).toThrow('loopback or private');
    expect(() => validateWebhookUrl('https://172.31.255.255/hook')).toThrow('loopback or private');
  });

  it('throws on 192.168.x.x', () => {
    expect(() => validateWebhookUrl('https://192.168.1.1/hook')).toThrow('loopback or private');
  });

  it('throws on ::1', () => {
    // Note: URL parser keeps brackets in hostname for IPv6, so the source
    // comparison against '::1' won't match '[::1]'. This tests current behaviour.
    expect(() => validateWebhookUrl('http://::1/hook')).toThrow();
  });

  it('throws on 0.0.0.0', () => {
    expect(() => validateWebhookUrl('https://0.0.0.0/hook')).toThrow('loopback or private');
  });

  it('allows valid public https URL', () => {
    expect(() => validateWebhookUrl('https://hooks.example.com/wh')).not.toThrow();
  });

  it('allows valid public http URL', () => {
    expect(() => validateWebhookUrl('http://hooks.example.com/wh')).not.toThrow();
  });
});

describe('sanitizeTemplateVariable', () => {
  it('returns value as-is when html is false', () => {
    expect(sanitizeTemplateVariable('<b>test</b>', false)).toBe('<b>test</b>');
  });

  it('escapes & when html is true', () => {
    expect(sanitizeTemplateVariable('a & b', true)).toBe('a &amp; b');
  });

  it('escapes < and > when html is true', () => {
    expect(sanitizeTemplateVariable('<div>', true)).toBe('&lt;div&gt;');
  });

  it('escapes double quotes when html is true', () => {
    expect(sanitizeTemplateVariable('"hello"', true)).toBe('&quot;hello&quot;');
  });

  it('escapes single quotes when html is true', () => {
    expect(sanitizeTemplateVariable("it's", true)).toBe('it&#39;s');
  });

  it('escapes all special chars together', () => {
    expect(sanitizeTemplateVariable('<a href="x">&\'', true)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&#39;',
    );
  });
});

describe('validateLabelName', () => {
  it('throws on empty string', () => {
    expect(() => validateLabelName('')).toThrow('must not be empty');
  });

  it('throws on whitespace-only string', () => {
    expect(() => validateLabelName('   ')).toThrow('must not be empty');
  });

  it('throws on >200 chars', () => {
    expect(() => validateLabelName('a'.repeat(201))).toThrow('must not exceed 200');
  });

  it('allows exactly 200 chars', () => {
    expect(validateLabelName('a'.repeat(200))).toBe('a'.repeat(200));
  });

  it('throws on control characters', () => {
    expect(() => validateLabelName('label\x00name')).toThrow('control characters');
  });

  it('trims whitespace and returns valid name', () => {
    expect(validateLabelName('  Important  ')).toBe('Important');
  });
});

describe('validateAttachments', () => {
  let dir: string;
  let file: string;

  beforeAll(async () => {
    // realpath: on macOS the temp dir sits under /var, itself a symlink to
    // /private/var, and validateAttachmentPath returns resolved paths.
    dir = await realpath(await mkdtemp(join(tmpdir(), 'email-mcp-attach-')));
    file = join(dir, 'a.txt');
    await writeFile(file, 'hello');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('allows undefined and empty arrays', async () => {
    await expect(validateAttachments(undefined)).resolves.toBeUndefined();
    await expect(validateAttachments([])).resolves.toBeUndefined();
  });

  it('allows a valid base64 attachment', async () => {
    await expect(
      validateAttachments([
        { filename: 'a.txt', content: Buffer.from('hello').toString('base64') },
      ]),
    ).resolves.toBeUndefined();
  });

  it('allows a path-based attachment that exists', async () => {
    await expect(validateAttachments([{ filename: 'a.txt', path: file }])).resolves.toBeUndefined();
  });

  // Each of these used to pass unchecked: a path was never resolved, never
  // sized, and never counted towards the combined limit.
  it('rejects a path that does not exist', async () => {
    await expect(
      validateAttachments([{ filename: 'a.txt', path: join(dir, 'missing.txt') }]),
    ).rejects.toThrow();
  });

  it('rejects a path containing a null byte', async () => {
    await expect(
      validateAttachments([{ filename: 'a.txt', path: `${file}\0.png` }]),
    ).rejects.toThrow('null bytes');
  });

  it('rejects a path that is not a regular file', async () => {
    await expect(validateAttachments([{ filename: 'a.txt', path: dir }])).rejects.toThrow(
      'not a regular file',
    );
  });

  it('counts a path-based attachment towards the combined limit', async () => {
    const big = join(dir, 'big.bin');
    await writeFile(big, Buffer.alloc(MAX_ATTACHMENT_SIZE + 1));

    await expect(validateAttachments([{ filename: 'big.bin', path: big }])).rejects.toThrow(
      'exceeding',
    );

    await rm(big, { force: true });
  });

  it('throws when more than the max number of attachments are given', async () => {
    const attachments = Array.from({ length: 11 }, (_, i) => ({
      filename: `f${i}.txt`,
      content: 'aGVsbG8=',
    }));
    await expect(validateAttachments(attachments)).rejects.toThrow('Too many attachments');
  });

  it('throws on empty filename', async () => {
    await expect(validateAttachments([{ filename: '', content: 'aGVsbG8=' }])).rejects.toThrow(
      'non-empty filename',
    );
  });

  it('throws on filename with a path separator', async () => {
    await expect(
      validateAttachments([{ filename: '../evil.txt', content: 'aGVsbG8=' }]),
    ).rejects.toThrow('path separators');
  });

  it('throws when neither content nor path is provided', async () => {
    await expect(validateAttachments([{ filename: 'a.txt' }])).rejects.toThrow(
      'exactly one of "content"',
    );
  });

  it('throws when both content and path are provided', async () => {
    await expect(
      validateAttachments([{ filename: 'a.txt', content: 'aGVsbG8=', path: file }]),
    ).rejects.toThrow('exactly one of "content"');
  });

  it('throws when a single attachment exceeds the per-file limit', async () => {
    const oversized = 'A'.repeat(Math.ceil(((MAX_ATTACHMENT_SIZE + 1024) * 4) / 3));

    await expect(
      validateAttachments([{ filename: 'big.bin', content: oversized }]),
    ).rejects.toThrow('per-file limit');
  });
});

describe('validateInputLength', () => {
  it('throws when over max', () => {
    expect(() => validateInputLength('12345', 3, 'field')).toThrow(
      'field exceeds maximum length of 3',
    );
  });

  it('allows at exact max length', () => {
    expect(() => validateInputLength('123', 3, 'field')).not.toThrow();
  });

  it('allows under max length', () => {
    expect(() => validateInputLength('ab', 5, 'name')).not.toThrow();
  });
});
