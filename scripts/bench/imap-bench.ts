/**
 * IMAP read-path benchmark.
 *
 * Measures the tool code paths that dominate perceived latency, reporting IMAP
 * commands issued and bytes moved alongside wall-clock time. Command counts are
 * the metric to compare across runs: they are deterministic, whereas network
 * latency varies enough between runs to hide a real regression.
 *
 * Read-only. Every scenario lists, searches or fetches; nothing writes, moves,
 * flags or deletes.
 *
 *   pnpm bench                      # default accounts, 5 runs
 *   pnpm bench -- --accounts=gmail --runs=3
 *   pnpm bench -- --label=after-palier-1
 *
 * Fixtures (which message, which thread) are discovered on first run and pinned
 * to scripts/bench/fixtures.json so a later run measures the same work. Delete
 * that file to re-discover.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config/loader.js';
import ConnectionManager from '../../src/connections/manager.js';
import ImapService from '../../src/services/imap.service.js';
import OAuthService from '../../src/services/oauth.service.js';
import { InstrumentedConnectionManager, type WireCounts } from './instrument.js';

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = join(BENCH_DIR, 'fixtures.json');
const RESULTS_DIR = join(BENCH_DIR, 'results');

const DEFAULT_ACCOUNTS = ['silvestre', 'gmail'];
const DEFAULT_RUNS = 5;

// ---------------------------------------------------------------------------
// Fixtures — pinned so before/after runs measure identical work
// ---------------------------------------------------------------------------

interface AccountFixtures {
  /** UID of a message carrying the largest attachment we could find. */
  messageWithAttachmentUid?: string;
  /** UIDs for the batch-read scenario. */
  batchUids: string[];
  /** Message-ID of the longest thread we could find. */
  longThreadMessageId?: string;
  /** UID whose folder `find_email_folder` will hunt for. */
  locateUid?: string;
  /** A mailbox other than INBOX with enough messages to page through. */
  secondaryMailbox?: string;
}

type FixtureFile = Record<string, AccountFixtures>;

async function loadFixtureFile(): Promise<FixtureFile> {
  try {
    return JSON.parse(await readFile(FIXTURES_PATH, 'utf-8')) as FixtureFile;
  } catch {
    return {};
  }
}

/**
 * Pick representative messages once, then reuse them.
 *
 * Discovery deliberately runs outside any measurement window — its own cost is
 * irrelevant, and it must not pollute the numbers.
 */
async function discoverFixtures(
  imapService: ImapService,
  accountName: string,
): Promise<AccountFixtures> {
  const fixtures: AccountFixtures = { batchUids: [] };

  const inboxPage = await imapService.listEmails(accountName, { mailbox: 'INBOX', pageSize: 40 });
  fixtures.batchUids = inboxPage.items.slice(0, 20).map((meta) => meta.id);

  // A message deep in the list is likelier to sit in a late folder, which is
  // what makes find_email_folder expensive.
  const lastListed = inboxPage.items.at(-1);
  if (lastListed) fixtures.locateUid = lastListed.id;

  // Deliberately a *large* message: the point of this scenario is that getEmail
  // pulls BODY.PEEK[] whole, attachments included, so a 200 B message would
  // measure nothing. Fall back to any message with an attachment if the mailbox
  // holds nothing bulky.
  const largeMessages = await imapService.searchEmails(accountName, '', {
    mailbox: 'INBOX',
    hasAttachment: true,
    largerThan: 500,
    pageSize: 5,
  });
  const anyAttachment =
    largeMessages.items.length > 0
      ? largeMessages
      : await imapService.listEmails(accountName, {
          mailbox: 'INBOX',
          hasAttachment: true,
          pageSize: 5,
        });
  const messageWithAttachment = anyAttachment.items[0];
  if (messageWithAttachment) fixtures.messageWithAttachmentUid = messageWithAttachment.id;

  // The longest thread we can spot cheaply: the subject seen most often.
  const subjectCounts = new Map<string, { count: number; messageId: string }>();
  inboxPage.items.forEach((meta) => {
    const normalizedSubject = (meta.subject ?? '')
      .replace(/^((re|fwd?|tr)\s*:\s*)+/i, '')
      .trim()
      .toLowerCase();
    if (!normalizedSubject) return;
    const seen = subjectCounts.get(normalizedSubject);
    if (seen) {
      seen.count += 1;
    } else {
      subjectCounts.set(normalizedSubject, { count: 1, messageId: meta.id });
    }
  });
  const busiestSubject = [...subjectCounts.values()].sort((a, b) => b.count - a.count)[0];
  if (busiestSubject) fixtures.longThreadMessageId = busiestSubject.messageId;

  const mailboxes = await imapService.listMailboxes(accountName);
  const busiestNonInbox = mailboxes
    .filter((mailbox) => mailbox.path !== 'INBOX' && mailbox.totalMessages > 50)
    .sort((a, b) => b.totalMessages - a.totalMessages)[0];
  if (busiestNonInbox) fixtures.secondaryMailbox = busiestNonInbox.path;

  return fixtures;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

interface Scenario {
  name: string;
  /** Why this scenario is in the suite — which finding it exercises. */
  targets: string;
  run: () => Promise<void>;
}

function buildScenarios(
  imapService: ImapService,
  accountName: string,
  fixtures: AccountFixtures,
): Scenario[] {
  const scenarios: Scenario[] = [
    {
      name: 'list_mailboxes',
      targets: 'STATUS par dossier (N+1), sérialisé sur une connexion',
      run: async () => {
        await imapService.listMailboxes(accountName);
      },
    },
    {
      name: 'list_emails page 1',
      targets: 'UID SEARCH ALL puis pagination en JS',
      run: async () => {
        await imapService.listEmails(accountName, { mailbox: 'INBOX', pageSize: 20 });
      },
    },
    {
      name: 'list_emails page 5',
      targets: 'même coût que la page 1 malgré une page tardive',
      run: async () => {
        await imapService.listEmails(accountName, { mailbox: 'INBOX', page: 5, pageSize: 20 });
      },
    },
    {
      name: 'list_emails has_attachment',
      targets: 'BODYSTRUCTURE sur tout le jeu avant pagination',
      run: async () => {
        await imapService.listEmails(accountName, {
          mailbox: 'INBOX',
          hasAttachment: true,
          pageSize: 20,
        });
      },
    },
    {
      name: 'search_emails',
      targets: 'IMAP SEARCH côté serveur puis pagination en JS',
      run: async () => {
        await imapService.searchEmails(accountName, 'facture', {
          mailbox: 'INBOX',
          pageSize: 20,
        });
      },
    },
    {
      name: 'get_email_stats (week)',
      targets: 'FETCH enveloppe + BODYSTRUCTURE de toute la période',
      run: async () => {
        await imapService.getEmailStats(accountName, 'INBOX', 'week');
      },
    },
  ];

  if (fixtures.secondaryMailbox) {
    const secondaryMailbox = fixtures.secondaryMailbox;
    scenarios.push({
      name: 'list_emails dossier secondaire',
      targets: 'même chemin hors INBOX',
      run: async () => {
        await imapService.listEmails(accountName, { mailbox: secondaryMailbox, pageSize: 20 });
      },
    });
  }

  if (fixtures.messageWithAttachmentUid) {
    const attachmentUid = fixtures.messageWithAttachmentUid;
    scenarios.push({
      name: 'get_email (pièce jointe)',
      targets: 'BODY.PEEK[] complet + download("1") redondant',
      run: async () => {
        await imapService.getEmail(accountName, attachmentUid, 'INBOX');
      },
    });
  }

  if (fixtures.batchUids.length > 0) {
    const { batchUids } = fixtures;
    scenarios.push({
      name: `get_emails (${batchUids.length} ids)`,
      targets: 'Promise.allSettled décoratif — sérialisé sur une connexion',
      run: async () => {
        await Promise.allSettled(
          batchUids.map(async (uid) => imapService.getEmail(accountName, uid, 'INBOX')),
        );
      },
    });
  }

  if (fixtures.longThreadMessageId) {
    const threadMessageId = fixtures.longThreadMessageId;
    scenarios.push({
      name: 'get_thread',
      targets: '3 SEARCH d’en-tête par référence, puis source complète par message',
      run: async () => {
        await imapService.getThread(accountName, threadMessageId, 'INBOX');
      },
    });
  }

  if (fixtures.locateUid) {
    const locateUid = fixtures.locateUid;
    scenarios.push({
      name: 'find_email_folder',
      targets: 'SELECT + SEARCH sur tous les dossiers, sans sortie anticipée',
      run: async () => {
        await imapService.findEmailFolder(accountName, locateUid, 'INBOX');
      },
    });
  }

  return scenarios;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface RunSample {
  durationMs: number;
  wire: WireCounts;
}

interface ScenarioResult {
  account: string;
  scenario: string;
  targets: string;
  medianDurationMs: number;
  p90DurationMs: number;
  commands: number;
  bytesRead: number;
  commandsByName: Record<string, number>;
  reconnects: number;
  error?: string;
}

function percentile(sortedValues: number[], fraction: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * fraction));
  return sortedValues[index] ?? 0;
}

function formatBytes(byteCount: number): string {
  if (byteCount < 1024) return `${byteCount} B`;
  if (byteCount < 1024 * 1024) return `${(byteCount / 1024).toFixed(1)} KB`;
  return `${(byteCount / (1024 * 1024)).toFixed(2)} MB`;
}

async function runScenario(
  scenario: Scenario,
  instrumented: InstrumentedConnectionManager,
  activeClients: () => Promise<never[]> | Promise<Parameters<typeof instrumented.endWindow>[0]>,
  runCount: number,
  accountName: string,
): Promise<ScenarioResult> {
  const samples: RunSample[] = [];
  let failure: string | undefined;

  // One unmeasured warm-up: the first call of a session pays connection setup
  // and label-strategy detection, which would otherwise land on run 1 alone.
  try {
    await scenario.run();
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  for (let runIndex = 0; runIndex < runCount && !failure; runIndex += 1) {
    instrumented.startWindow();
    const startedAt = performance.now();
    try {
      // eslint-disable-next-line no-await-in-loop
      await scenario.run();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      break;
    }
    const durationMs = performance.now() - startedAt;
    // eslint-disable-next-line no-await-in-loop
    const wire = instrumented.endWindow(await activeClients());
    samples.push({ durationMs, wire });
  }

  // Each metric gets its own median. Taking them all from whichever run landed
  // in the middle of the array would report one arbitrary run, not the typical
  // value of each measurement.
  const median = (values: number[]): number =>
    percentile(
      [...values].sort((a, b) => a - b),
      0.5,
    );

  const durations = samples.map((sample) => sample.durationMs);
  const commandCounts = samples.map((sample) => sample.wire.totalCommands);
  const byteCounts = samples.map((sample) => sample.wire.bytesRead);

  // The command breakdown has to come from one run to stay self-consistent;
  // pick the run whose command count is the median.
  const representative =
    samples.find((sample) => sample.wire.totalCommands === median(commandCounts)) ?? samples[0];

  return {
    account: accountName,
    scenario: scenario.name,
    targets: scenario.targets,
    medianDurationMs: Math.round(median(durations)),
    p90DurationMs: Math.round(
      percentile(
        [...durations].sort((a, b) => a - b),
        0.9,
      ),
    ),
    commands: Math.round(median(commandCounts)),
    bytesRead: Math.round(median(byteCounts)),
    commandsByName: representative?.wire.commandsByName ?? {},
    reconnects: Math.max(0, (representative?.wire.socketCount ?? 1) - 1),
    error: failure,
  };
}

function renderMarkdown(results: ScenarioResult[], label: string, runCount: number): string {
  const lines: string[] = [
    `# Banc IMAP — ${label}`,
    '',
    `Généré le ${new Date().toISOString()} · ${runCount} runs par scénario (médiane).`,
    '',
    'La colonne **cmd** (commandes IMAP émises) est la métrique de référence : elle est',
    'déterministe, contrairement à la durée qui dépend du réseau.',
    '',
    '| Compte | Scénario | cmd | octets lus | médiane | p90 |',
    '|---|---|---:|---:|---:|---:|',
  ];

  results.forEach((result) => {
    if (result.error) {
      lines.push(
        `| ${result.account} | ${result.scenario} | — | — | — | échec : ${result.error} |`,
      );
      return;
    }
    lines.push(
      `| ${result.account} | ${result.scenario} | ${result.commands} | ${formatBytes(result.bytesRead)} | ${result.medianDurationMs} ms | ${result.p90DurationMs} ms |`,
    );
  });

  lines.push('', '## Détail des commandes par scénario', '');
  results
    .filter((result) => !result.error)
    .forEach((result) => {
      const breakdown = Object.entries(result.commandsByName)
        .map(([name, count]) => `${name}×${count}`)
        .join(', ');
      lines.push(`- **${result.account} / ${result.scenario}** — ${breakdown || 'aucune'}`);
      lines.push(`  <br>cible : ${result.targets}`);
      if (result.reconnects > 0) {
        lines.push(`  <br>⚠️ ${result.reconnects} reconnexion(s) pendant la mesure`);
      }
    });

  return `${lines.join('\n')}\n`;
}

function parseArgs(): { accounts: string[]; runs: number; label: string } {
  const args = process.argv.slice(2);
  const readFlag = (flagName: string): string | undefined =>
    args
      .find((arg) => arg.startsWith(`--${flagName}=`))
      ?.split('=')
      .slice(1)
      .join('=');

  return {
    accounts: readFlag('accounts')?.split(',').filter(Boolean) ?? DEFAULT_ACCOUNTS,
    runs: Number(readFlag('runs') ?? DEFAULT_RUNS),
    label: readFlag('label') ?? 'baseline',
  };
}

async function main(): Promise<void> {
  const { accounts, runs, label } = parseArgs();

  const config = await loadConfig();
  // Compression is negotiated per connection; ConnectionManager read the flag
  // when this module's imports were evaluated, and parseArgs sets nothing here,
  // so the caller must export MCP_EMAIL_IMAP_DISABLE_COMPRESSION=true. The
  // pnpm bench script does that — warn if something else invoked us.
  if (process.env.MCP_EMAIL_IMAP_DISABLE_COMPRESSION !== 'true') {
    process.stderr.write(
      'Attention : COMPRESS=DEFLATE est actif. Les octets mesurés sont compressés ' +
        "et le dictionnaire deflate reste chaud d'un run à l'autre, ce qui rend la " +
        'colonne « octets lus » inexploitable. Lancez via `pnpm bench`.\n',
    );
  }
  const connectionManager = new ConnectionManager(config.accounts, new OAuthService());
  const instrumented = new InstrumentedConnectionManager(connectionManager);
  const imapService = new ImapService(instrumented);

  const configuredAccounts = new Set(connectionManager.getAccountNames());
  const accountsToBench = accounts.filter((name) => configuredAccounts.has(name));
  const skipped = accounts.filter((name) => !configuredAccounts.has(name));
  if (skipped.length > 0) {
    process.stderr.write(`Comptes absents de la config, ignorés : ${skipped.join(', ')}\n`);
  }

  const fixtureFile = await loadFixtureFile();
  const results: ScenarioResult[] = [];

  for (const accountName of accountsToBench) {
    process.stderr.write(`\n=== ${accountName} ===\n`);

    let fixtures = fixtureFile[accountName];
    if (!fixtures) {
      process.stderr.write('Découverte des fixtures (hors mesure)…\n');
      // eslint-disable-next-line no-await-in-loop
      fixtures = await discoverFixtures(imapService, accountName);
      fixtureFile[accountName] = fixtures;
      // eslint-disable-next-line no-await-in-loop
      await writeFile(FIXTURES_PATH, `${JSON.stringify(fixtureFile, null, 2)}\n`, 'utf-8');
      process.stderr.write(`Fixtures épinglées dans ${FIXTURES_PATH}\n`);
    }

    const scenarios = buildScenarios(imapService, accountName, fixtures);
    const collectActiveClients = async () => [await instrumented.getImapClient(accountName)];

    for (const scenario of scenarios) {
      process.stderr.write(`  ${scenario.name}… `);
      // eslint-disable-next-line no-await-in-loop
      const result = await runScenario(
        scenario,
        instrumented,
        collectActiveClients,
        runs,
        accountName,
      );
      results.push(result);
      process.stderr.write(
        result.error
          ? `échec : ${result.error}\n`
          : `${result.commands} cmd · ${formatBytes(result.bytesRead)} · ${result.medianDurationMs} ms\n`,
      );
    }
  }

  await connectionManager.closeAll();

  const report = renderMarkdown(results, label, runs);
  await mkdir(RESULTS_DIR, { recursive: true });
  const reportPath = join(RESULTS_DIR, `${label}.md`);
  await writeFile(reportPath, report, 'utf-8');

  process.stdout.write(`\n${report}`);
  process.stderr.write(`\nRapport écrit dans ${reportPath}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
