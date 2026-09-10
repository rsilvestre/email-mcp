/**
 * Build a short text preview from a partially fetched message body.
 *
 * Listings fetch only the first few hundred bytes of one body part, so every
 * step here has to tolerate input that is cut mid-encoding: a base64 stream
 * truncated off a 4-byte boundary, or a quoted-printable escape sliced in half.
 */

/**
 * Bytes fetched per message for the preview, before decoding.
 *
 * Measured against 80 live messages: plain text is usable from 600 bytes, but
 * HTML mail spends its opening kilobyte on head boilerplate — usable previews
 * go from 11/27 at 600 bytes to 25/27 at 1500, and gain nothing beyond that.
 */
export const PREVIEW_PART_BYTES = 1500;

/**
 * Markup in a part the sender declared as text/plain. Bulk senders do this
 * often enough that trusting the declared type leaves CSS in the preview.
 */
const LOOKS_LIKE_MARKUP = /<(?:html|body|div|table|style|head|meta|span|p|br)\b/i;

/**
 * Below this many characters, a preview built from markup is residue rather
 * than content. Plain text is exempt: a short message is still worth showing.
 */
const MIN_MARKUP_PREVIEW = 20;

/** Characters kept in the finished preview. */
export const PREVIEW_LENGTH = 200;

/** Strip tags and decode the handful of entities that survive tag removal. */
export function stripHtml(html: string): string {
  return (
    html
      .replace(/<!DOCTYPE[^>]*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      // Outlook conditional comments are routinely cut off unterminated.
      .replace(/<!--[\s\S]*$/, ' ')
      // The head of an HTML mail is meta and link tags — never content.
      .replace(/<head[\s\S]*?<\/head>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      // A truncated fetch can end inside a style, script or head block, leaving
      // no closing tag for the rules above to match.
      .replace(/<(?:style|script|head)\b[\s\S]*$/i, ' ')
      .replace(/<[^>]+>/g, ' ')
      // …and can equally end inside an ordinary tag, which would otherwise
      // survive tag removal and show up as "<meta name=" in the preview.
      .replace(/<[^>]*$/, ' ')
      .replace(/\s+/g, ' ')
      // Every tag becomes a space, so "<b>word</b>," would read "word ,".
      .replace(/ +([,.;:!?)\]])/g, '$1')
      .trim()
  );
}

/** Decode quoted-printable, discarding an escape the truncation cut in half. */
function decodeQuotedPrintable(raw: Buffer): Buffer {
  const text = raw
    .toString('latin1')
    // Soft line breaks join the line to the next one.
    .replace(/=\r?\n/g, '')
    // A trailing "=" or "=A" is the start of an escape we did not fetch.
    .replace(/=[0-9A-Fa-f]?$/, '');

  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '=' && i + 2 < text.length) {
      const hex = text.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
      } else {
        out.push(text.charCodeAt(i));
      }
    } else {
      out.push(text.charCodeAt(i));
    }
  }
  return Buffer.from(out);
}

/** Decode base64, dropping the trailing bytes that do not form a whole group. */
function decodeBase64(raw: Buffer): Buffer {
  const cleaned = raw.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '');
  const whole = cleaned.slice(0, cleaned.length - (cleaned.length % 4));
  return Buffer.from(whole, 'base64');
}

/** Undo the part's Content-Transfer-Encoding. */
export function decodeTransferEncoding(raw: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? '').toLowerCase()) {
    case 'quoted-printable':
      return decodeQuotedPrintable(raw);
    case 'base64':
      return decodeBase64(raw);
    default:
      // 7bit, 8bit, binary, or unspecified — the bytes are already the content.
      return raw;
  }
}

/** Charset labels that already mean UTF-8, so the sniff below is pointless. */
const UTF8_LABELS = new Set(['utf-8', 'utf8', 'unicode-1-1-utf-8', 'csutf8']);

/**
 * Drop a trailing UTF-8 sequence the fetch cut in half.
 *
 * Previews stop at a byte count rather than a character boundary, so the last
 * one to three bytes are routinely an incomplete sequence. Testing the buffer
 * for valid UTF-8 without trimming them would fail on perfectly good UTF-8.
 */
function withoutTruncatedSequence(buffer: Buffer): Buffer {
  for (let back = 1; back <= 3 && back <= buffer.length; back += 1) {
    const byte = buffer[buffer.length - back];
    // A lead byte this close to the end has no room for its continuation bytes.
    if (byte >= 0xc0) return buffer.subarray(0, buffer.length - back);
    if (byte < 0x80) break; // ASCII: nothing was cut.
  }
  return buffer;
}

/**
 * Does this look like UTF-8 regardless of what the sender called it?
 *
 * Real mail mislabels its charset often — Outlook in particular declares
 * Windows-1252 while sending UTF-8 — and decoding those bytes as declared
 * turns every accented character into mojibake.
 *
 * Multi-byte UTF-8 sequences are structurally constrained, so genuine
 * Windows-1252 text almost never forms valid ones by chance: "é" in
 * Windows-1252 is a single 0xE9 byte, which is not valid UTF-8 at all. A high
 * byte plus a clean strict decode is therefore strong evidence.
 */
function looksLikeUtf8(buffer: Buffer): boolean {
  const testable = withoutTruncatedSequence(buffer);
  // Pure ASCII decodes identically either way, so there is nothing to correct.
  if (!testable.some((byte) => byte >= 0x80)) return false;

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(testable);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decode bytes with the part's declared charset, unless the bytes say otherwise.
 *
 * `fatal: false` matters for the final decode: the fetch cuts the body
 * mid-character often enough that a strict decoder would throw on ordinary mail.
 */
export function decodeCharset(buffer: Buffer, charset: string | undefined): string {
  const label = (charset ?? 'utf-8').toLowerCase();

  // Trust the bytes over the label where they disagree.
  if (!UTF8_LABELS.has(label) && looksLikeUtf8(buffer)) {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }

  try {
    return new TextDecoder(label, { fatal: false }).decode(buffer);
  } catch {
    // Unknown label — TextDecoder throws on construction, not on decode.
    return buffer.toString('utf-8');
  }
}

/** Named entities common in mail; anything else is decoded numerically. */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  // Zero-width characters, used by bulk senders to pad the preheader.
  zwnj: '',
  zwj: '',
  shy: '',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

/**
 * Decode HTML entities and drop zero-width padding.
 *
 * Applied to plain-text parts too: senders put entities in them, and a preview
 * reading "&zwnj; &zwnj; &zwnj;" is worse than showing nothing.
 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(
      /&([a-z]+);/gi,
      (match: string, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match,
    )
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
}

/**
 * Cut the text where a stylesheet begins.
 *
 * Bulk senders concatenate the preheader and the CSS into a single part, with
 * no tag to mark the boundary, so the readable half is the prefix. Matches an
 * at-rule, a CSS comment, or a selector followed by a declaration block.
 */
export function cutAtStyleSheet(text: string): string {
  const start = text.search(
    /\/\*|@(?:media|font-face|import|supports)\b|[a-z-]+\s*[,{][^{}]*[:;]/i,
  );
  return start === -1 ? text : text.slice(0, start);
}

/** The body part a preview should be built from. */
export interface PreviewPart {
  /** IMAP section number to fetch. */
  key: string;
  type: string;
  encoding?: string;
  charset?: string;
}

interface StructureNode {
  part?: string;
  type?: string;
  encoding?: string;
  disposition?: string;
  parameters?: { charset?: string };
  childNodes?: StructureNode[];
}

function toPart(node: StructureNode, key: string): PreviewPart | undefined {
  if (!node.type?.startsWith('text/')) {
    return undefined;
  }
  return { key, type: node.type, encoding: node.encoding, charset: node.parameters?.charset };
}

/**
 * Decide which section to fetch for the preview.
 *
 * Section 1 is the body of a single-part message and the first alternative of a
 * multipart, which covers the overwhelming majority of mail. When section 1 is
 * itself a multipart — around 4% of messages in practice — the text sits at
 * 1.1, which callers must fetch in a second pass restricted to those messages:
 * asking for a section a message does not have fails the whole batch on Gmail.
 */
export function findPreviewPart(bodyStructure: unknown): PreviewPart | undefined {
  if (!bodyStructure || typeof bodyStructure !== 'object') {
    return undefined;
  }
  const root = bodyStructure as StructureNode;
  const first = root.childNodes?.find((child) => child.part === '1') ?? root;

  if (!first.type?.startsWith('multipart')) {
    return toPart(first, '1');
  }

  const nested = first.childNodes?.find((child) => child.part === '1.1');
  return nested ? toPart(nested, '1.1') : undefined;
}

/** The body parts a full message read should fetch. */
export interface BodyTextParts {
  plain?: PreviewPart;
  html?: PreviewPart;
}

/**
 * Locate the message body among the MIME parts.
 *
 * Unlike findPreviewPart, which only ever looks at sections 1 and 1.1, this
 * walks the whole structure: the readable body of a multipart/mixed sits beside
 * its attachments, and multipart/related nests it another level down.
 *
 * Parts marked as attachments are skipped — an attached .txt or .html is a file
 * the caller may download by name, not the text of the message.
 */
export function findBodyTextParts(bodyStructure: unknown): BodyTextParts {
  const found: BodyTextParts = {};
  if (!bodyStructure || typeof bodyStructure !== 'object') return found;

  const visit = (node: StructureNode, sectionKey: string): void => {
    if (node.childNodes?.length) {
      node.childNodes.forEach((child) => {
        visit(child, child.part ?? sectionKey);
      });
      return;
    }
    if (node.disposition === 'attachment') return;

    // A single-part message has no part number; its body is section 1.
    const key = node.part ?? sectionKey;
    if (node.type === 'text/plain' && !found.plain) {
      found.plain = toPart(node, key);
    } else if (node.type === 'text/html' && !found.html) {
      found.html = toPart(node, key);
    }
  };

  visit(bodyStructure as StructureNode, '1');
  return found;
}

/** Decode a fetched part into a one-line preview, or undefined if it is empty. */
export function buildPreview(raw: Buffer, part: PreviewPart): string | undefined {
  const decoded = decodeCharset(decodeTransferEncoding(raw, part.encoding), part.charset);
  // Trust the content over the declared type: a text/plain part carrying markup
  // would otherwise put raw CSS in the preview.
  const isMarkup = part.type === 'text/html' || LOOKS_LIKE_MARKUP.test(decoded);
  const stripped = isMarkup ? stripHtml(decoded) : decoded;
  const text = cutAtStyleSheet(decodeEntities(stripped).replace(/\s+/g, ' ').trim())
    // The fetch can end mid-character: a complete "=C3" escape is still an
    // incomplete UTF-8 sequence, which decodes to U+FFFD. That is truncation
    // damage, not content.
    .replace(/\uFFFD+\s*$/, '')
    .trimEnd();

  if (text.length < (isMarkup ? MIN_MARKUP_PREVIEW : 1)) {
    return undefined;
  }
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH).trimEnd()}…` : text;
}
