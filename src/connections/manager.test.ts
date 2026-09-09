import type { AccountConfig } from '../types/index.js';
import ConnectionManager from './manager.js';

type MockListener = (...args: unknown[]) => void;
interface MockClient {
  usable: boolean;
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  on: (event: string, listener: MockListener) => MockClient;
  emit: (event: string, ...args: unknown[]) => boolean;
}

const imapInstances = vi.hoisted(() => [] as MockClient[]);

/** Lets a test make the next N connect() attempts fail. */
const imapControl = vi.hoisted(() => ({ failNextConnectCount: 0 }));

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
