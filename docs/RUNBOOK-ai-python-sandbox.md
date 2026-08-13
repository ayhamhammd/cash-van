# Runbook — the AI assistant's Python sandbox

SPEC-ai-analyst Phase 4. **Ships disabled.** Read this before turning it on;
the decision is not obvious and the cost is not only memory.

## What it buys you

The analyst persona gets `run_python`: pandas, numpy, matplotlib and openpyxl
over the rows of a query it already ran. That covers what SQL cannot express —
regression, cohort and retention curves, clustering, and charts as image files.

Everything else in the assistant works without it. If you are unsure, leave it
off; the honest answer is that most questions are answered by SQL and a report.

## What it costs

**Memory.** The image is ~550 MB on disk and each run takes up to 512 MB of RAM.
The reference on-prem install reported **1.87 GB of container memory with 698 MB
already in use**. On that box this is a real bite and can push the API or
Postgres into swap. Check headroom first:

```bash
docker stats --no-stream
```

**Privilege — the part that matters.** Spawning a container requires access to
the Docker socket, and **that access is root-equivalent on the host**. Granting
it to the API process trades a sandboxing problem for a privilege problem: an
attacker who achieves code execution in the API container can then start a
privileged container and own the machine.

That is a genuine trade, not a formality. It is the reason this ships disabled
and the reason there is no "just turn it on" instruction below without this
paragraph above it.

Do not enable it on a host that also runs another customer's system.

## What the sandbox actually enforces

Verified by running each case against the built image, not asserted:

| Property | How |
|---|---|
| No network | `--network none` — exfiltration removed as a category, not policed as a rule |
| No credentials | Data arrives as `/job/data.json`, already fetched by the read-only role. There is no connection string to steal. |
| Read-only root | `--read-only` plus a 64 MB `noexec,nosuid` tmpfs |
| Cannot rewrite its own source | `/job` mounted `:ro`; only `/job/out` is writable |
| Non-root | uid 10001, `--cap-drop ALL`, `--security-opt no-new-privileges` |
| Bounded | 512 MB, swap off, 1 cpu, 64 pids, 30 s wall clock ending in SIGKILL |
| No path escape in outputs | Output names are flattened to a basename |

All eight verified passing. Re-run that verification after any change to the
image or the flags — the value of this feature is entirely in those properties
holding.

## Turning it on

1. Build the image on the host that runs the API:

   ```bash
   docker build -t vanflow-pysandbox:latest assets/sandbox
   ```

2. Give the API container the Docker socket. **Re-read "Privilege" above first.**

   ```yaml
   services:
     app:
       volumes:
         - /var/run/docker.sock:/var/run/docker.sock
   ```

3. Set the flag:

   ```
   AI_PYTHON_ENABLED=true
   ```

4. Recreate the API container and ask the assistant, as the **Data analyst**
   expert, for something that needs it — "chart this month's sales by rep as a
   PNG". A chart file should appear in the artifacts panel.

## Settings

| Variable | Default | Notes |
|---|---|---|
| `AI_PYTHON_ENABLED` | `false` | The only one that matters |
| `AI_PYTHON_IMAGE` | `vanflow-pysandbox:latest` | |
| `AI_PYTHON_TIMEOUT_MS` | `30000` | Wall clock, then SIGKILL |
| `AI_PYTHON_MEMORY` | `512m` | Swap is disabled at this value |
| `AI_PYTHON_CPUS` | `1` | |
| `AI_PYTHON_MAX_ROWS` | `50000` | Rows handed to the script |

## When it is off

`run_python` is still offered to the analyst, and replies that it is not enabled
with a message telling the model to answer with SQL instead. That is deliberate:
a tool that silently vanishes makes the assistant claim it cannot do something
it could do on another install, and a model that gets a clear "not enabled" does
not retry it three times.

## Troubleshooting

**"Could not start the sandbox: spawn docker ENOENT"** — no docker binary in the
API container. The socket alone is not enough; the client must be installed too.

**"permission denied ... docker.sock"** — the socket is mounted but the API runs
as a non-root user that is not in the host's docker group.

**"Unable to find image"** — built on the wrong host, or built for the wrong
architecture. On a Windows/Docker Desktop install build it there, not on a Mac.

**Runs are killed at 30 s** — either the model wrote something pathological, or
the row count is too high. Lower `AI_PYTHON_MAX_ROWS` before raising the timeout;
a slow analysis is usually too much data, not too little time.
