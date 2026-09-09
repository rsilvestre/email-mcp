import type { AccountConfig } from '../types/index.js';
import ConnectionManager from './manager.js';

type MockListener = (...args: unknown[]) => void;
interface MockClient {
  usable: boolean;
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  noop: ReturnType<typeof vi.fn>;
  on: (event: string, listener: MockListener) => MockClient;
  emit: (event: string, ...args: unknown[]) => boolean;
}

const imapInstances = vi.hoisted(() => [] as MockClient[]);

/**
 * Lets a test steer the mock connection: fail the next N connect() attempts, or
 * decide how a liveness probe behaves ('ok', 'reject', or 'hang' for a socket
 * that has been dropped without anyone noticing).
 */
const imapControl = vi.hoisted(() => ({
  failNextConnectCount: 0,
  probeBehaviour: 'ok' as 'ok' | 'reject' | 'hang',
}));

vi.mock('imapflow', () => {
  class MockImapFlow {
    usable = true;
    connect = vi.fn().mockImplementation(async () => {
      if (imapControl.failNextConnectCount > 0) {
        imapControl.failNextConnectCount -= 1;
        throw new Error('ECONNREFUSED');
      }
      return undefined;
    });
    close = vi.fn();
    logout = vi.fn().mockResolvedValue(undefined);
    noop = vi.fn().mockImplementation(async () => {
      if (imapControl.probeBehaviour === 'reject') throw new Error('Connection closed');
      if (imapControl.probeBehaviour === 'hang') return new Promise(() => {});
      return undefined;
    });
    private listeners = new Map<string, MockListener[]>();

    constructor(_options: unknown) {
      imapInstances.push(this as unknown as MockClient);
    }

    on(event: string, listener: MockListener) {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string, ...args: unknown[]) {
      const listeners = this.listeners.get(event) ?? [];
      for (const listener of listeners) listener(...args);
      if (event === 'error' && listeners.length === 0) throw args[0];
      return listeners.length > 0;
    }
  }

  return { ImapFlow: MockImapFlow };
});

vi.mock('../logging.js', () => ({ mcpLog: vi.fn().mockResolvedValue(undefined) }));

const account: AccountConfig = {
  name: 'test',
  email: 'test@example.com',
  username: 'test@example.com',
  password: 'password',
  imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
};

describe('ConnectionManager IMAP lifecycle', () => {
  beforeEach(() => {
    imapInstances.length = 0;
  });

  it('handles ImapFlow error events and reconnects on the next request', async () => {
    const manager = new ConnectionManager([account]);
    const first = (await manager.getImapClient('test')) as unknown as MockClient;

    expect(() => first.emit('error', new Error('Socket timeout'))).not.toThrow();

    const second = (await manager.getImapClient('test')) as unknown as MockClient;
    expect(second).not.toBe(first);
    expect(imapInstances).toHaveLength(2);
  });

  it('does not let a late error from a stale client invalidate its replacement', async () => {
    const manager = new ConnectionManager([account]);
    const first = (await manager.getImapClient('test')) as unknown as MockClient;

    first.emit('error', new Error('Connection lost'));
    const replacement = (await manager.getImapClient('test')) as unknown as MockClient;

    first.emit('error', new Error('Late stale error'));
    const current = (await manager.getImapClient('test')) as unknown as MockClient;

    expect(current).toBe(replacement);
    expect(imapInstances).toHaveLength(2);
  });

  it('invalidates the cached client when it closes', async () => {
    const manager = new ConnectionManager([account]);
    const first = (await manager.getImapClient('test')) as unknown as MockClient;

    first.emit('close');
    const second = (await manager.getImapClient('test')) as unknown as MockClient;

    expect(second).not.toBe(first);
  });
});

describe('ConnectionManager concurrent IMAP connection setup', () => {
  beforeEach(() => {
    imapInstances.length = 0;
    imapControl.failNextConnectCount = 0;
  });

  it('opens a single connection when callers race for a cold account', async () => {
    const manager = new ConnectionManager([account]);

    const clients = await Promise.all(
      Array.from({ length: 8 }, async () => manager.getImapClient('test')),
    );

    // One socket, not eight: every extra ImapFlow built here would connect and
    // then be dropped from the map unreferenced, never logged out.
    expect(imapInstances).toHaveLength(1);
    expect(imapInstances[0]?.connect).toHaveBeenCalledTimes(1);
    expect(new Set(clients).size).toBe(1);
  });

  it('lets the next call retry after a failed connection attempt', async () => {
    const manager = new ConnectionManager([account]);
    imapControl.failNextConnectCount = 1;

    await expect(manager.getImapClient('test')).rejects.toThrow('ECONNREFUSED');

    // The in-flight entry must be cleared on rejection, or this call would join
    // the already-rejected promise and the account would never recover.
    await expect(manager.getImapClient('test')).resolves.toBeDefined();
    expect(imapInstances).toHaveLength(2);
  });

  it('fails every racing caller together when the shared attempt fails', async () => {
    const manager = new ConnectionManager([account]);
    imapControl.failNextConnectCount = 1;

    const outcomes = await Promise.allSettled(
      Array.from({ length: 4 }, async () => manager.getImapClient('test')),
    );

    expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true);
    expect(imapInstances).toHaveLength(1);
  });
});

describe('ConnectionManager stale IMAP connection detection', () => {
  // The manager probes a pooled connection that has been idle past its
  // threshold. Fake timers let a test age a connection without waiting, and
  // let the probe's own timeout fire on demand.
  const IDLE_THRESHOLD_MS = 60_000;
  const PROBE_TIMEOUT_MS = 5_000;

  beforeEach(() => {
    imapInstances.length = 0;
    imapControl.failNextConnectCount = 0;
    imapControl.probeBehaviour = 'ok';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses a recently used connection without probing it', async () => {
    const manager = new ConnectionManager([account]);
    const first = (await manager.getImapClient('test')) as unknown as MockClient;

    const second = (await manager.getImapClient('test')) as unknown as MockClient;

    // Probing on every call would spend a round trip to save none.
    expect(first.noop).not.toHaveBeenCalled();
    expect(second).toBe(first);
    expect(imapInstances).toHaveLength(1);
  });

  it('probes an idle connection and reuses it when it answers', async () => {
    const manager = new ConnectionManager([account]);
    const first = (await manager.getImapClient('test')) as unknown as MockClient;

    await vi.advanceTimersByTimeAsync(IDLE_THRESHOLD_MS + 1_000);
    const second = (await manager.getImapClient('test')) as unknown as MockClient;

    expect(first.noop).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    // A live connection must survive the probe: rebuilding here would throw
    // away the pooling this whole class exists for.
    expect(imapInstances).toHaveLength(1);
  });

  it('rebuilds when an idle connection rejects the probe', async () => {
    const manager = new ConnectionManager([account]);
    const first = (await manager.getImapClient('test')) as unknown as MockClient;

    imapControl.probeBehaviour = 'reject';
    await vi.advanceTimersByTimeAsync(IDLE_THRESHOLD_MS + 1_000);
    const second = (await manager.getImapClient('test')) as unknown as MockClient;

    expect(second).not.toBe(first);
    expect(imapInstances).toHaveLength(2);
  });

  it('rebuilds when an idle connection never answers the probe', async () => {
    const manager = new ConnectionManager([account]);
    const first = (await manager.getImapClient('test')) as unknown as MockClient;

    // The case that actually bites: the socket was dropped silently, so the
    // command is never answered and never rejected. Without the probe timeout
    // this call would hang exactly as the tool call used to.
    imapControl.probeBehaviour = 'hang';
    await vi.advanceTimersByTimeAsync(IDLE_THRESHOLD_MS + 1_000);

    const pending = manager.getImapClient('test');
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 100);
    const second = (await pending) as unknown as MockClient;

    expect(second).not.toBe(first);
    expect(imapInstances).toHaveLength(2);
  });

  it('probes once when callers race on an idle connection', async () => {
    const manager = new ConnectionManager([account]);
    const first = (await manager.getImapClient('test')) as unknown as MockClient;

    await vi.advanceTimersByTimeAsync(IDLE_THRESHOLD_MS + 1_000);
    const clients = await Promise.all(
      Array.from({ length: 5 }, async () => manager.getImapClient('test')),
    );

    // The probe belongs inside the in-flight guard, or five callers send five
    // NOOPs to answer the same question.
    expect(first.noop).toHaveBeenCalledTimes(1);
    expect(new Set(clients).size).toBe(1);
    expect(imapInstances).toHaveLength(1);
  });
});

describe('ConnectionManager IMAP pooling', () => {
  /** Resolve a promise from outside, to hold work open while asserting. */
  function deferred() {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { held, release };
  }

  beforeEach(() => {
    imapInstances.length = 0;
    imapControl.failNextConnectCount = 0;
    imapControl.probeBehaviour = 'ok';
  });

  it('spreads a burst of work across several connections', async () => {
    const manager = new ConnectionManager([account]);
    const gate = deferred();

    // Twenty tasks dispatched in one tick, as get_emails does. All of them see
    // the pool before any connection has finished opening, which is exactly the
    // case a lazily-grown pool gets wrong.
    const tasks = Array.from({ length: 20 }, async () =>
      manager.withImapClient('test', async () => gate.held),
    );

    await Promise.resolve();
    gate.release();
    await Promise.all(tasks);

    expect(imapInstances).toHaveLength(3);
  });

  it('never exceeds the pool ceiling', async () => {
    const manager = new ConnectionManager([account]);
    const gate = deferred();

    const tasks = Array.from({ length: 50 }, async () =>
      manager.withImapClient('test', async () => gate.held),
    );

    await Promise.resolve();
    gate.release();
    await Promise.all(tasks);

    expect(imapInstances.length).toBeLessThanOrEqual(3);
  });

  it('opens only one connection for sequential work', async () => {
    const manager = new ConnectionManager([account]);

    // Growth is driven by work actually waiting, not by how many calls happen.
    for (let call = 0; call < 10; call += 1) {
      // eslint-disable-next-line no-await-in-loop
      await manager.withImapClient('test', async () => undefined);
    }

    expect(imapInstances).toHaveLength(1);
  });

  it('does not grow the pool for getImapClient callers', async () => {
    const manager = new ConnectionManager([account]);

    // A bare client hands out no signal about when it is finished, so growing
    // here would open sockets nothing measured the need for.
    await Promise.all(Array.from({ length: 10 }, async () => manager.getImapClient('test')));

    expect(imapInstances).toHaveLength(1);
  });

  it('runs the task on a connected client', async () => {
    const manager = new ConnectionManager([account]);

    const seen = await manager.withImapClient('test', async (client) => client);

    expect(imapInstances[0]).toBe(seen as unknown as MockClient);
    expect((seen as unknown as MockClient).connect).toHaveBeenCalledTimes(1);
  });

  it('releases its slot when the task throws', async () => {
    const manager = new ConnectionManager([account]);

    await expect(
      manager.withImapClient('test', async () => {
        throw new Error('fetch failed');
      }),
    ).rejects.toThrow('fetch failed');

    // The in-flight count must come back down, or the next call would think the
    // connection is busy and open another for nothing.
    await manager.withImapClient('test', async () => undefined);
    expect(imapInstances).toHaveLength(1);
  });

  it('closes every pooled connection on shutdown', async () => {
    const manager = new ConnectionManager([account]);
    const gate = deferred();

    const tasks = Array.from({ length: 20 }, async () =>
      manager.withImapClient('test', async () => gate.held),
    );
    await Promise.resolve();
    gate.release();
    await Promise.all(tasks);

    await manager.closeAll();

    expect(imapInstances).toHaveLength(3);
    const loggedOut = imapInstances.filter((client) => client.logout.mock.calls.length > 0);
    expect(loggedOut).toHaveLength(imapInstances.length);
  });
});

describe('ConnectionManager spare connection reaping', () => {
  const IDLE_THRESHOLD_MS = 60_000;

  function deferred() {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { held, release };
  }

  /** Open the pool up to its ceiling with one burst of concurrent work. */
  async function fillPool(manager: ConnectionManager) {
    const gate = deferred();
    const tasks = Array.from({ length: 20 }, async () =>
      manager.withImapClient('test', async () => gate.held),
    );
    await Promise.resolve();
    gate.release();
    await Promise.all(tasks);
  }

  beforeEach(() => {
    imapInstances.length = 0;
    imapControl.failNextConnectCount = 0;
    imapControl.probeBehaviour = 'ok';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes spare connections once they have gone quiet', async () => {
    const manager = new ConnectionManager([account]);
    await fillPool(manager);
    expect(imapInstances).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(IDLE_THRESHOLD_MS + 1_000);
    await manager.withImapClient('test', async () => undefined);

    // Extra sockets are not free after the burst: a server shares an account's
    // throughput across them, which measurably slowed unrelated sequential
    // work. The steady state should be one connection.
    const loggedOut = imapInstances.filter((client) => client.logout.mock.calls.length > 0);
    expect(loggedOut).toHaveLength(2);
  });

  it('keeps the connection everything else uses', async () => {
    const manager = new ConnectionManager([account]);
    await fillPool(manager);
    const primary = imapInstances[0];

    await vi.advanceTimersByTimeAsync(IDLE_THRESHOLD_MS + 1_000);
    await manager.getImapClient('test');

    expect(primary?.logout).not.toHaveBeenCalled();
    // Reaping must not cost a reconnection.
    expect(imapInstances).toHaveLength(3);
  });

  it('leaves spares alone while they are still working', async () => {
    const manager = new ConnectionManager([account]);
    await fillPool(manager);

    const gate = deferred();
    const busy = Array.from({ length: 20 }, async () =>
      manager.withImapClient('test', async () => gate.held),
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(IDLE_THRESHOLD_MS + 1_000);
    await manager.getImapClient('test');

    const loggedOut = imapInstances.filter((client) => client.logout.mock.calls.length > 0);
    expect(loggedOut).toHaveLength(0);

    gate.release();
    await Promise.all(busy);
  });

  it('opens spares again for the next burst', async () => {
    const manager = new ConnectionManager([account]);
    await fillPool(manager);

    await vi.advanceTimersByTimeAsync(IDLE_THRESHOLD_MS + 1_000);
    await manager.withImapClient('test', async () => undefined);
    await fillPool(manager);

    // Reaped connections are replaced by new ones, not resurrected.
    expect(imapInstances.length).toBeGreaterThan(3);
  });
});
