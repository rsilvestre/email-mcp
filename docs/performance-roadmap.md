# Performance Improvements Roadmap

> **Status**: Partly delivered — see *Delivered* below  
> **Last Updated**: 2026-09-09

Performance for an Email MCP server operates across **three distinct layers**, each with different bottlenecks and optimization strategies. This roadmap identifies concrete improvements against the current implementation, ordered by impact.

## Key Insight

> The AI agent's **context window** — not IMAP speed — is the primary performance constraint.
> Returning 100 email bodies might be technically fast over IMAP, but it would **destroy** the LLM's context window budget.
> Therefore, **response shaping** (returning only what the AI needs, in the most compact form) is the #1 performance technique.

---

## Delivered

Measured on two live Gmail accounts (~2500 messages each) with
`pnpm bench`, comparing IMAP **commands issued** before and after. Command
counts are deterministic; wall-clock times in the same runs varied by 2–3×
between runs and are not the basis for any claim here.

| Change | Effect |
|---|---|
| Body fetched by MIME part instead of `BODY.PEEK[]` | `get_email` 5 → 2 commands. A message with 4 PDFs stopped transferring 4.6 MB to display 1.8 KB of text. |
| `find_email_folder` stops at the first match, likely folders first | 45 → 4 commands |
| Attachment filter resolved in growing batches | Dense mailbox: same 3 commands, 82% fewer bytes, 1687 → 363 ms. Sparse mailbox: 3 → 4 commands, 25% fewer bytes, 1457 → 1270 ms. |
| Thread header searches OR'd together | 3 searches per Message-ID → 3 in total |
| Idle connections probed before reuse | Removes the stall-then-succeed-on-retry pattern |
| Concurrent connection setup deduplicated | Stops leaking unreferenced open sockets |
| `email://{account}/stats` uses STATUS + one SEARCH | Was a full envelope scan of the period, behind a comment claiming otherwise |

**Caution learned from measuring.** Batching the attachment filter at a fixed
200 UIDs made the sparse case *worse* — 3 commands and 1457 ms became 8 and
2250 ms on the account where attachments are rare — while clearly improving the
dense one. Growing the batches geometrically brought it to 4 commands and
1270 ms: one round trip more than before, for a quarter fewer bytes. A change
that trades bytes for round trips has to be measured on both shapes of mailbox
before it can be called a win, and the honest result here is a modest gain, not
the large one the dense case suggested.

**Measure before claiming anything.** Gmail negotiates `COMPRESS=DEFLATE`, and
the deflate dictionary stays warm for the life of the connection, so repeating
a request costs almost nothing on the wire regardless of payload. An early run
here reported a 25000× byte reduction that was an artefact of exactly that.
`pnpm bench` disables compression for this reason; see `scripts/bench/README.md`.

## Current State Assessment

### What's Already Well-Implemented ✅

| Technique | Status | Where |
|-----------|--------|-------|
| ENVELOPE fetching for listings | ✅ Done | `imap.service.ts` — uses `{ envelope: true }` |
| BODYSTRUCTURE for attachment detection | ✅ Done | `imap.service.ts` — uses `{ bodyStructure: true }` |
| Server-side IMAP SEARCH | ✅ Done | `imap.service.ts` — builds IMAP SEARCH criteria (subject, from, body, date, flags) |
| UID-based tracking | ✅ Done | All operations use `{ uid: true }` |
| Lazy connection creation | ✅ Done | `manager.ts` — connects on first use per account |
| Connection health checks | ✅ Done | `manager.ts` — checks `.usable` before reuse; SMTP `verify()` |
| Auto-reconnect (basic) | ✅ Done | `manager.ts` — drops stale connections, recreates on failure |
| Source preview truncation | ✅ Done | `imap.service.ts` — `maxLength: 256` for list operations |
| Preview text capping | ✅ Done | `imap.service.ts` — 200 char preview limit |
| Thread cap | ✅ Done | Thread reconstruction capped at 50 messages |
| Contact extraction cap | ✅ Done | Caps at 500 recent messages for contact extraction |
| Rate limiting (sends) | ✅ Done | `rate-limiter.ts` — token-bucket, 10/min/account |
| Graceful shutdown | ✅ Done | `manager.ts` — `closeAll()` closes all connections |
| Selective MIME part fetching | ✅ Done | `imap.service.ts` — `findBodyTextParts` picks the body part; no full-source download |
| Idle connection probing | ✅ Done | `manager.ts` — NOOP with a bounded timeout past `MCP_EMAIL_IMAP_IDLE_PROBE_MS` |
| Connection setup deduplication | ✅ Done | `manager.ts` — concurrent callers join one attempt |
| Early exit in folder lookup | ✅ Done | `imap.service.ts` — `findEmailFolder` stops at the first match |
| Bounded thread reconstruction | ✅ Done | `imap.service.ts` — `searchHeaderAnyOf` ORs the header terms |
| Repeatable measurement | ✅ Done | `scripts/bench/` — commands and payload bytes per scenario |

### What's Missing ❌

| Gap | Current Behavior | Impact |
|-----|-----------------|--------|
| Conservative SMTP pool defaults | Pooling defaults to `max_connections=1`, `max_messages=100` | Low — tune for high-throughput workloads |
| No ENVELOPE/BODYSTRUCTURE cache | Fresh SEARCH + FETCH every request | High — repeat listings pay full IMAP cost |
| Client-side pagination | `UID SEARCH ALL` returns every UID, sliced in memory | Open — the attachment filter no longer scans everything, but the UID list itself is still fetched whole |
| No IMAP command pipelining control | Relies on ImapFlow auto-pipelining (good) but fetches extra data | Low — ImapFlow handles this well already |
| No signature/quote stripping | Returns full body including signatures and quoted replies | Medium — wastes tokens on repeated content |
| No IMAP IDLE for push | Only poll-based; no real-time arrival notifications | Low — not critical for MCP request/response model |
| No batch flag operations | One-at-a-time for mark/move/delete | Low — current usage patterns are single-message |

---

## Improvement Roadmap

### Phase 1: High-Impact, Low-Effort

These improvements offer the best performance gains for minimal code changes.

#### P1.1 — Enable Nodemailer SMTP Connection Pooling

**Impact**: Medium | **Effort**: Trivial (1 line change)

```typescript
// connections/manager.ts — when creating transport
const transport = nodemailer.createTransport({
  host, port, secure,
  auth: { user, pass },
  pool: true,          // ← ADD THIS
  maxConnections: 3,   // ← ADD THIS  
  maxMessages: 50,     // ← ADD THIS
});
```

**What it does**: Reuses SMTP connections across sends. Eliminates TLS handshake + AUTH per message. Nodemailer handles queuing, recycling, and connection health automatically.

**Current state**: Transport pooling is enabled with conservative defaults and can be tuned per account.

#### P1.2 — Server-Side UID Pagination (Replace Client-Side Slicing)

**Impact**: High | **Effort**: Low

**Current behavior**: `listEmails()` searches ALL matching UIDs, then slices `uids.slice(start, end)` in memory. For a 10K-message inbox, this means fetching 10K UIDs just to show 20.

**Target behavior**: Use UID ranges to paginate server-side:
```typescript
// Instead of: search all → slice
// Do: search with UID range constraint

// For "page 1, size 20" of a mailbox with 10000 messages:
// 1. Use SEARCH to get total count (or mailbox.exists)
// 2. Compute UID range for the desired page
// 3. FETCH only those UIDs
```

**Approach**: 
- Use `client.status(mailbox, { messages: true, uidNext: true })` for total count
- Compute UID offset for the requested page
- Add UID range to SEARCH criteria: `{ uid: 'start:end' }`
- Eliminates O(N) UID fetch for large mailboxes

#### P1.3 — ENVELOPE/BODYSTRUCTURE In-Memory Cache

**Impact**: High | **Effort**: Medium

**Current behavior**: Every `listEmails()` call does a fresh SEARCH + FETCH, even for the same mailbox/page. Navigating back and forth repeats full IMAP round-trips.

**Target behavior**: Cache ENVELOPE and BODYSTRUCTURE per `account:mailbox:UID`, invalidated when `UIDVALIDITY` changes.

```typescript
interface CacheEntry {
  envelope: MessageEnvelope;
  bodyStructure: MessageStructure;
  flags: string[];
  cachedAt: number;
}

// Key: `${account}:${mailbox}:${uid}`
// Invalidate: when UIDVALIDITY changes or cache exceeds max entries
// Max entries: configurable, default 1000 per account
// TTL: none (UIDs are immutable per UIDVALIDITY)
// Flags: always re-fetch (flags change frequently)
```

**What it does**: Repeat listings and email metadata lookups are near-instant (<10ms vs 200-500ms). Thread reconstruction benefits most — currently does N FETCHes for N messages in thread.

---

### Phase 2: Response Shaping (Token Efficiency)

These improvements reduce AI context window consumption — the true bottleneck.

#### P2.1 — Selective MIME Part Fetching

**Impact**: High | **Effort**: Medium

**Current behavior**: `getEmail()` downloads full message source, then parses. For a 2MB email with attachments, this transfers 2MB when only the 5KB text body is needed.

**Target behavior**: 
1. Fetch BODYSTRUCTURE first (already cached from listing)
2. Find the `text/plain` part number from the MIME tree
3. Fetch only `BODY.PEEK[partNumber]` for that part
4. Fetch `text/html` only if explicitly requested or no plain text exists

```typescript
// Instead of:
const source = await client.download(uid, undefined, { uid: true });

// Do:
const structure = getCachedBodyStructure(uid) ?? await fetchBodyStructure(uid);
const textPart = findTextPlainPart(structure); // Walk MIME tree
const body = await client.download(uid, textPart.part, { uid: true });
```

**Savings**: 10-100x less data transfer per email. Plain text body is typically 1-10KB vs full source at 100KB-10MB.

#### P2.2 — Email Signature & Quoted Reply Stripping

**Impact**: Medium | **Effort**: Medium

**Current behavior**: Full body returned including `-- \n` signatures, legal disclaimers, and `> > > ` quoted reply chains that repeat the entire conversation.

**Target behavior**: Detect and strip common patterns, return clean body + metadata flags:
```typescript
interface EmailBody {
  text: string;           // Clean body content
  hasSignature: boolean;  // Signature was stripped
  hasQuotedReply: boolean; // Quoted content was stripped  
  fullLength: number;     // Original length before stripping
}
```

**Detection patterns**:
- `-- \n` or `--\n` (standard signature delimiter)
- `On ... wrote:` / `-----Original Message-----` (quoted replies)
- Common legal disclaimers (`CONFIDENTIALITY NOTICE`, `This email and any attachments...`)

**Savings**: Quoted reply chains can 10x the body length. A 5-message thread where each reply quotes all previous messages contains 5x duplicate content.

#### P2.3 — Body Truncation with Overflow Indicator

**Impact**: Medium | **Effort**: Low

**Current behavior**: Full body returned regardless of length. A single long email can consume thousands of tokens.

**Target behavior**: Truncate at configurable limit (default 4000 chars), with overflow metadata:
```typescript
interface GetEmailResponse {
  // ... existing fields
  body: string;           // Truncated if too long
  truncated: boolean;     // True if body was cut
  totalLength: number;    // Original full length
}
```

The AI can request the full body explicitly if needed (add `fullBody: true` parameter).

#### P2.4 — Structured Thread Summaries

**Impact**: High | **Effort**: Medium

**Current behavior**: `getThread()` returns full message objects for every message in the thread. A 20-message thread returns 20 full bodies.

**Target behavior**: Return compact thread summary by default, with option to expand individual messages:
```typescript
interface ThreadSummary {
  threadId: string;
  messageCount: number;
  participants: string[];
  subject: string;
  messages: ThreadMessage[];
}

interface ThreadMessage {
  uid: number;
  from: string;        // Short: "John <john@...>"
  date: string;        // ISO 8601
  snippet: string;     // First 150 chars of body
  hasAttachments: boolean;
  // Full body NOT included — request via getEmail(uid)
}
```

**Savings**: 20-message thread as snippets ≈ 1K tokens; full bodies ≈ 40K tokens.

---

### Phase 3: Connection Management Hardening

These improvements increase reliability and reduce latency for sustained usage sessions.

#### P3.1 — Connection Pool with Checkout/Checkin

**Impact**: Medium | **Effort**: High

**Current behavior**: Single ImapFlow instance per account (singleton pattern). If two tool calls arrive simultaneously, they queue on the mailbox lock.

**Target behavior**: Pool of 1-3 ImapFlow instances per account:
```typescript
class ImapConnectionPool {
  private pool: Map<string, ImapFlow[]>;  // account → connections
  private maxPerAccount: number = 3;
  
  async checkout(account: string): Promise<PooledConnection>;
  release(connection: PooledConnection): void;
}
```

**Benefits**: 
- Concurrent list + read operations on the same account don't block each other
- Graceful degradation: if one connection drops, others continue
- Respects IMAP server limits (Gmail: 15 concurrent, Outlook: 10)

**Note**: ImapFlow's mailbox lock already handles safety within a single instance. Pool adds multi-instance parallelism.

#### P3.2 — Robust Auto-Reconnect with Backoff

**Impact**: Medium | **Effort**: Low-Medium

**Current behavior**: Drops stale connection and recreates. No retry delay — immediate reconnect.

**Target behavior**: Exponential backoff with jitter:
```typescript
// Reconnect strategy:
// Attempt 1: immediate
// Attempt 2: 1s + jitter
// Attempt 3: 2s + jitter
// Attempt 4: 4s + jitter
// Max attempts: 5
// Max delay: 30s
```

**Why**: Prevents thundering herd on temporary network issues. Avoids IMAP server ban from rapid reconnect attempts.

#### P3.3 — NOOP Keepalive for Idle Connections

**Impact**: Low-Medium | **Effort**: Low

**Current behavior**: No explicit keepalive. Connections may timeout after 30 minutes of inactivity (common IMAP server default).

**Target behavior**: Periodic NOOP every 5 minutes on idle connections:
```typescript
// On each pool connection, if no activity for 5 minutes:
setInterval(() => {
  if (connection.usable && timeSinceLastActivity > 5 * 60 * 1000) {
    connection.noop();
  }
}, 60_000);
```

**Why**: Avoids 200-500ms reconnect penalty after idle periods during interactive AI sessions.

---

### Phase 4: Advanced Optimizations (Future)

These are lower priority but provide meaningful improvements for power users.

#### P4.1 — IMAP MOVE Command (RFC 6851)

**Current**: Uses COPY + DELETE (two commands). **Target**: Use native MOVE when server supports it (single command, atomic). Check capability `MOVE` in server response.

#### P4.2 — CONDSTORE/QRESYNC Change Detection

**Current**: ImapFlow auto-negotiates these extensions but we don't leverage mod-sequences. **Target**: Track `highestModSeq` per mailbox; on re-list, fetch only messages with `MODSEQ > lastSeen`. Dramatically reduces re-fetch cost for large mailboxes.

#### P4.3 — Contact Cache

**Current**: Extracts contacts from 100-500 recent messages on every call. **Target**: Cache extracted contacts per account with 10-minute TTL. Contact lists change slowly.

#### P4.4 — IMAP IDLE for Real-Time Notifications

**Current**: Not implemented. **Target**: Optional IDLE mode that emits events on new message arrival. Useful for MCP resource subscriptions if the protocol adds support.

#### P4.5 — Selective BODYSTRUCTURE Fetch

**Current**: Fetches BODYSTRUCTURE on every list operation alongside ENVELOPE. **Target**: Only fetch BODYSTRUCTURE when `has_attachment` filter is requested or when `getEmail()` needs MIME navigation. Reduces data per message in standard listings.

---

## Performance Budget (Target Latencies)

| Operation | Current (est.) | Target | Target (cached) |
|-----------|---------------|--------|-----------------|
| `list_emails` (page of 20) | ~800ms | < 500ms | < 50ms |
| `get_email` | ~1.5s | < 1s | < 500ms (envelope cached) |
| `send_email` (no attachment) | ~3s | < 2s | N/A |
| `search_emails` | ~2s | < 2s | < 1s (UID cache) |
| `get_thread` (10 messages) | ~3s | < 1.5s | < 200ms (all cached) |
| `list_mailboxes` | ~500ms | < 500ms | < 50ms |
| `move_email` | ~500ms | < 500ms | N/A |

---

## Anti-Patterns to Avoid

| ❌ Anti-Pattern | Why It's Bad | ✅ Instead |
|----------------|--------------|------------|
| Fetch ALL UIDs then slice client-side | O(N) for large mailboxes; wastes memory | UID-range server-side pagination |
| Download full message source for body | Transfers attachments+HTML when only text needed | Selective MIME part fetch via BODYSTRUCTURE |
| Return entire thread as full bodies | Blows AI context window (40K+ tokens) | Structured snippets, load on demand |
| No SMTP connection pooling | TLS+AUTH overhead on every send | `pool: true` in Nodemailer |
| Fresh FETCH for every listing | 200-500ms per request for same data | In-memory ENVELOPE cache per UID |
| No connection timeout/backoff | Hangs on unresponsive server; thundering herd | Exponential backoff with jitter |
| Return quoted reply chains in body | 10x token waste on duplicate content | Strip quotes, flag `hasQuotedReply` |
| Cache email bodies in memory | Memory explosion on large mailboxes | Cache only ENVELOPE + BODYSTRUCTURE |

---

## Library Performance Features Reference

### ImapFlow — Already Handles For Us

| Feature | How | Notes |
|---------|-----|-------|
| ENVELOPE/BODYSTRUCTURE fetch | `fetch(range, { envelope: true, bodyStructure: true })` | Pre-parsed, compact |
| BODY.PEEK (no side effects) | Automatic with `bodyParts` | Never marks as Seen |
| Command pipelining | Automatic | Reduces round-trips |
| Server-side IMAP SEARCH | `client.search(criteria)` | Full RFC 3501 SEARCH |
| Async streaming | `for await (let msg of client.fetch(...))` | Low memory for large sets |
| CONDSTORE/QRESYNC | Auto-negotiated | Efficient change tracking |
| COMPRESS=DEFLATE | Auto-negotiated | Bandwidth reduction |
| Mailbox locking | `client.getMailboxLock()` | Concurrency safety |
| Gmail extensions | Auto-detected | Labels, Gmail SEARCH |

### Nodemailer — Already Handles For Us (once `pool: true` is set)

| Feature | How | Notes |
|---------|-----|-------|
| Connection pooling | `pool: true` | Reuses TCP/TLS connections |
| Connection recycling | `maxMessages: N` | Prevents stale connections |
| Concurrent sends | `maxConnections: N` | Queue + distribute |
| TLS/STARTTLS | `secure: true` | Automatic negotiation |
| OAuth2 _(experimental)_ | Built-in | Token refresh supported |
| Timeouts | `connectionTimeout`, `socketTimeout` | Prevents hanging |

### What We Build On Top

| Component | Purpose |
|-----------|---------|
| Connection pool manager | Multi-instance ImapFlow pool per account |
| ENVELOPE/BODYSTRUCTURE cache | In-memory, UID-keyed, UIDVALIDITY-invalidated |
| Response shaper | Truncation, signature strip, structured summaries |
| Smart MIME fetcher | Walk BODYSTRUCTURE tree, fetch text/plain only |
| Reconnect handler | Exponential backoff with jitter |
| Pagination engine | UID-range server-side pagination |
