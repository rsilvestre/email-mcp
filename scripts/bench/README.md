# IMAP read-path benchmark

Measures the tool code paths that dominate perceived latency, so a performance
change can be shown to work rather than asserted.

```bash
pnpm bench                                        # default accounts, 5 runs
pnpm bench -- --accounts=gmail --runs=3
pnpm bench -- --label=after-palier-1              # names the report file
```

Reports land in `scripts/bench/results/<label>.md`.

## What it measures, and what to compare

Each scenario reports three things. **Compare the command count**, not the clock:

| Metric | Use |
|---|---|
| **cmd** — IMAP commands issued | The metric of record. Deterministic run to run, so a drop is a real reduction in round trips. |
| **octets lus** — bytes off the socket | Catches fetches that ask for too much (a whole message to show its text). |
| médiane / p90 — wall clock | Context only. Network variance between runs is wide enough to hide a genuine regression, so never conclude from time alone. |

Commands are counted by swapping in a counting logger on the `ImapFlow`
instance: imapflow logs every compiled command it sends at `debug` with
`src: 'c'`. Production sets `logger: false`, which installs no-op log functions,
so the instrumentation changes no connection behaviour. Bytes come from the
underlying TLS socket's cumulative `bytesRead` / `bytesWritten`, accumulated per
socket so a mid-run reconnect neither loses nor double-counts a delta — the
report flags any scenario where the connection was rebuilt mid-measurement.

Only the command *name* is recorded, never its arguments: search terms,
Message-IDs and mailbox names would otherwise end up in a report file.

## Safety

Read-only. Every scenario lists, searches or fetches. Nothing writes, moves,
flags, marks or deletes, and the benchmark never touches SMTP.

## Fixtures

Which message, which thread, which folder — discovered on the first run and
pinned to `scripts/bench/fixtures.json`. Later runs reuse them so a before/after
comparison measures identical work. Delete the file to re-discover, but do so
for *both* sides of a comparison or the numbers are not comparable.

Discovery runs outside any measurement window, so its own cost never lands in
the results.

`fixtures.json` and `results/` are git-ignored: they name real mailboxes, UIDs
and Message-IDs from whoever ran the benchmark.

## Method

- One unmeasured warm-up call per scenario. The first call of a session pays
  connection setup and label-strategy detection, which would otherwise be
  charged entirely to run 1.
- Then N measured runs; the report gives the median, and p90 for the clock.
- The connection is shared across scenarios, exactly as the server runs it.

## Reading a result

Two shapes of finding show up:

- **A high command count** — the code is making round trips it does not need.
  `find_email_folder` at 21 `SELECT` + 21 `SEARCH` is scanning every folder
  without stopping at the match.
- **A high byte count for few commands** — the code is asking for too much per
  round trip. `get_email` pulling megabytes for one message means `BODY.PEEK[]`
  is fetching attachments to display text.

## Not covered here

A stale-connection stall — where an idle socket has been dropped silently, the
next call blocks until it times out, and the retry then succeeds — is not
reproducible on demand and so is not a scenario. It needs its own targeted test
that forces the socket closed before issuing a call.
