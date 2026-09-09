/**
 * Instrumentation for the IMAP benchmark.
 *
 * Wraps a real ConnectionManager so benchmark scenarios can run through the
 * ordinary ImapService code path while we count what actually crosses the wire.
 *
 * Two metrics are collected per scenario:
 *
 *  - **IMAP commands issued** — the metric that matters. imapflow logs every
 *    compiled command it sends at `debug` with `src: 'c'` (imap-flow.js:529).
 *    Production sets `logger: false`, which installs no-op log functions, so
 *    swapping in a counting logger changes no behaviour. Command *counts* are
 *    deterministic across runs; wall-clock latency is not.
 *  - **Socket bytes** — read from the underlying TLS socket's cumulative
 *    `bytesRead` / `bytesWritten`, accumulated per socket so a mid-run
 *    reconnect does not lose or double-count a delta.
 *
 * Only the command *name* is retained (never the arguments): search terms,
 * Message-IDs and mailbox names would otherwise end up in a committed report.
 */

import type { ImapFlow } from 'imapflow';
import type { Transporter } from 'nodemailer';
import type ConnectionManager from '../../src/connections/manager.js';
import type { IConnectionManager } from '../../src/connections/types.js';
import type { AccountConfig } from '../../src/types/index.js';

/** What a single measured window observed. */
export interface WireCounts {
  totalCommands: number;
  commandsByName: Record<string, number>;
  bytesRead: number;
  bytesWritten: number;
  /** Sockets seen during the window; > 1 means the connection was rebuilt. */
  socketCount: number;
}

/** The cumulative byte counters every Node socket exposes. */
interface SocketCounters {
  bytesRead: number;
  bytesWritten: number;
}

interface ImapFlowLogger {
  debug: (entry: Record<string, unknown>) => void;
  info: (entry: Record<string, unknown>) => void;
  warn: (entry: Record<string, unknown>) => void;
  error: (entry: Record<string, unknown>) => void;
  trace: (entry: Record<string, unknown>) => void;
}

/** An ImapFlow with the internals the instrumentation reaches into. */
interface InstrumentableClient extends ImapFlow {
  log: ImapFlowLogger;
  socket?: SocketCounters | false;
}

/**
 * Pull the command name out of a compiled IMAP command line.
 *
 * Lines look like `A7 UID SEARCH ALL` or `A3 STATUS "INBOX" (MESSAGES)`. The
 * leading token is the tag; `UID` is a prefix rather than a command, so it is
 * kept together with the command it qualifies.
 */
function extractCommandName(compiledCommand: string): string {
  const tokens = compiledCommand.trim().split(/\s+/);
  const afterTag = tokens.slice(1);
  if (afterTag.length === 0) return 'UNKNOWN';

  const firstWord = (afterTag[0] ?? '').toUpperCase();
  if (firstWord === 'UID' && afterTag.length > 1) {
    return `UID ${(afterTag[1] ?? '').toUpperCase()}`;
  }
  return firstWord;
}

/** Accumulates wire activity for whichever measurement window is open. */
class WireRecorder {
  private totalCommands = 0;

  private commandsByName = new Map<string, number>();

  /** Sockets seen in this window, with the reading taken when first seen. */
  private socketBaselines = new Map<SocketCounters, { bytesRead: number; bytesWritten: number }>();

  recordCommand(compiledCommand: string): void {
    this.totalCommands += 1;
    const commandName = extractCommandName(compiledCommand);
    this.commandsByName.set(commandName, (this.commandsByName.get(commandName) ?? 0) + 1);
  }

  /**
   * Register a socket's baseline for this window.
   *
   * A socket already open when the window opened contributes only the bytes it
   * moves from here on, so its baseline is its current reading. A socket first
   * seen when the window *closes* was created during the window — every byte it
   * carries belongs to the window, so its baseline is zero. Getting this wrong
   * in either direction silently mis-reports a reconnect.
   */
  observeSocket(socket: SocketCounters | false | undefined, phase: 'open' | 'close'): void {
    if (!socket || this.socketBaselines.has(socket)) return;
    this.socketBaselines.set(
      socket,
      phase === 'open'
        ? { bytesRead: socket.bytesRead, bytesWritten: socket.bytesWritten }
        : { bytesRead: 0, bytesWritten: 0 },
    );
  }

  reset(): void {
    this.totalCommands = 0;
    this.commandsByName.clear();
    this.socketBaselines.clear();
  }

  /** Settle every observed socket's delta and return the window's totals. */
  collect(): WireCounts {
    let bytesRead = 0;
    let bytesWritten = 0;

    this.socketBaselines.forEach((baseline, socket) => {
      bytesRead += Math.max(0, socket.bytesRead - baseline.bytesRead);
      bytesWritten += Math.max(0, socket.bytesWritten - baseline.bytesWritten);
    });

    return {
      totalCommands: this.totalCommands,
      commandsByName: Object.fromEntries([...this.commandsByName.entries()].sort()),
      bytesRead,
      bytesWritten,
      socketCount: this.socketBaselines.size,
    };
  }
}

/**
 * A ConnectionManager decorator that instruments every IMAP client it hands out.
 *
 * Implements IConnectionManager so ImapService accepts it unchanged — the code
 * under measurement is exactly the production code path.
 */
export class InstrumentedConnectionManager implements IConnectionManager {
  private readonly recorder = new WireRecorder();

  /** Clients already fitted with the counting logger. */
  private readonly instrumentedClients = new WeakSet<ImapFlow>();

  constructor(private readonly delegate: ConnectionManager) {}

  getAccount(name: string): AccountConfig {
    return this.delegate.getAccount(name);
  }

  getAccountNames(): string[] {
    return this.delegate.getAccountNames();
  }

  async getSmtpTransport(
    accountName: string,
    options?: { verify?: boolean },
  ): Promise<Transporter> {
    return this.delegate.getSmtpTransport(accountName, options);
  }

  async closeAll(): Promise<void> {
    return this.delegate.closeAll();
  }

  async getImapClient(accountName: string): Promise<ImapFlow> {
    const client = (await this.delegate.getImapClient(accountName)) as InstrumentableClient;

    if (!this.instrumentedClients.has(client)) {
      this.attachCountingLogger(client);
      this.instrumentedClients.add(client);
    }

    // Sample the socket on the way out so a window that only reuses an existing
    // client still establishes its byte baseline.
    this.recorder.observeSocket(client.socket, 'open');
    return client;
  }

  /**
   * Replace the client's no-op logger with one that counts outgoing commands.
   *
   * Production runs with `logger: false`, so every level is already a no-op;
   * counting in `debug` adds nothing observable to the connection's behaviour.
   */
  private attachCountingLogger(client: InstrumentableClient): void {
    const noop = (): void => undefined;
    client.log = {
      debug: (entry: Record<string, unknown>) => {
        if (entry.src === 'c' && typeof entry.msg === 'string') {
          this.recorder.recordCommand(entry.msg);
        }
      },
      info: noop,
      warn: noop,
      error: noop,
      trace: noop,
    };
  }

  /** Begin a measurement window. */
  startWindow(): void {
    this.recorder.reset();
  }

  /**
   * Close the measurement window.
   *
   * `activeClients` are re-sampled so byte deltas include everything written
   * after the window opened.
   */
  endWindow(activeClients: ImapFlow[]): WireCounts {
    activeClients.forEach((client) => {
      this.recorder.observeSocket((client as InstrumentableClient).socket, 'close');
    });
    return this.recorder.collect();
  }
}
