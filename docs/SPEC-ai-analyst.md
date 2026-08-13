# SPEC — AI Analyst

Status: **draft, not started**
Owner: —
Supersedes: the floating report-agent widget (`AiChatFab`), which stays until Phase 3 ships.

Turn the current report agent into a full-page assistant that can read the whole
database, reason as one of four named experts, and hand back real deliverables
(Excel, PDF, charts) — on a budget that suits a single-server on-prem install.

---

## 1. Where we actually are

Not a greenfield build. What exists today:

| Piece | File | State |
|---|---|---|
| Chat loop + tool dispatch | `src/modules/agent/agent.service.ts` | works |
| Read-only DB role | `scripts/sql/report-agent-role.sql`, `db/readonly-db.service.ts` | works |
| SQL allow-list validator | `sql/sql-validator.ts` (+ spec) | works |
| Three LLM providers | `llm/{anthropic,openai,gemini}.provider.ts` | works |
| Tools | `tools/tool-definitions.ts` | 3 tools |
| Report rendering | `reports/report-renderer.service.ts` | json, markdown, text, xlsx |
| Conversation storage | `entities/agent-conversation.entity.ts` | one row, `messages` jsonb |
| UI | `AiChatFab.tsx` (400×600 widget), `/ai-insights` | separate surfaces |

The engine is sound. The gaps are **surface**, **deliverables**, **expertise**
and **storage** — in that order of user-visible impact.

### What "not a real AI chat" means concretely

1. It answers questions. It does not **decide** anything or flag what is wrong
   unprompted.
2. It cannot produce a PDF — the tool description explicitly tells the model to
   refuse.
3. It cannot compute anything SQL cannot express: no trend fitting, no
   clustering, no charts.
4. A 400px widget cannot show a 30-row table, so answers get truncated in
   practice even when they are correct.
5. Every turn re-sends the whole jsonb blob; there is no per-message record, so
   no cost accounting, no partial retry, no search across history.

---

## 2. The four experts

One chat, a selectable expert. Each is a **system-prompt module plus a tool
allow-list**, not a separate service.

| Expert | Answers | Extra tools |
|---|---|---|
| **Cash Admin** (`admin`) | "Should I approve this discount?" "Who is over their credit limit?" | `run_sql`, `get_schema` |
| **Auditor** (`auditor`) | "What looks wrong today?" — runs a fixed check battery | `run_sql`, `run_checks` |
| **Sales Coach** (`sales`) | "Which customers are slipping?" "Where should rep 101 prospect?" | `run_sql`, `get_geo` |
| **Analyst** (`analyst`) | "Trend my tobacco margin by month, as a PDF" | all, incl. `run_python` |

Default is **Analyst**. The expert is stored on the session, changeable
mid-thread (recorded as a system message so the transcript stays honest about
which persona produced which answer).

### Cash Admin must recommend, never execute

It reads. It never writes. When it concludes "approve this", it renders a
button that calls the **existing** approvals endpoint under the operator's own
JWT and RBAC. The model never holds a write credential. This is the single most
important boundary in this document: an LLM with an approval token on a live
credit ledger is not a feature, it is an incident waiting for a prompt
injection to arrive through a customer name.

### Auditor: fixed checks, not free-form suspicion

A model asked "find problems" invents them. The auditor runs a **versioned SQL
check battery** and the model only *explains and prioritises* the rows it
returns. Initial checks:

| Check | Query shape |
|---|---|
| Voucher with no payment lines | `voucher_headers` LEFT JOIN `payments`, SALE, `is_posted` |
| Customer over credit limit | `total_debt > credit_limit AND credit_limit > 0` |
| Discount above policy | line `discount_value / (qty*unit_price) > threshold` |
| Sale outside the customer's geofence | `sale_lat/lng` vs `customers.lat/lng`, haversine |
| Collection never deposited | `status = 'confirmed'` older than N days |
| Rep with sales but no visits | `voucher_headers` vs `customer_visits` for the day |
| Van stock below zero | `van_stock.qty < 0` |
| Voucher not exported to ERP | `erp_outbox` stuck rows, `erp_id_map` gap |

Each check is a row in `ai_checks` (id, key, title_ar, title_en, sql, severity,
enabled) so an admin can disable one without a deploy, and so a check that
starts throwing can be switched off without disabling the auditor.

---

## 3. Data model

Replaces the single-blob storage. New migration, additive; `agent_conversations`
is left in place and read-only for one release, then dropped.

```
ai_sessions
  id            uuid pk
  title         text                     -- model-generated after turn 1
  persona       text not null            -- admin | auditor | sales | analyst
  created_by    uuid                     -- users.id
  model         text                     -- resolved model id, for cost history
  input_tokens  bigint not null default 0
  output_tokens bigint not null default 0
  cost_micros   bigint not null default 0 -- millionths of the billing currency
  archived_at   timestamptz
  created_at    timestamptz not null default now()
  updated_at    timestamptz not null default now()

ai_messages
  id            uuid pk
  session_id    uuid not null references ai_sessions on delete cascade
  seq           integer not null          -- 1-based, unique per session
  role          text not null             -- user | assistant | tool | system
  content       text                      -- rendered text, null for pure tool turns
  blocks        jsonb not null default '[]'  -- provider-native blocks, verbatim
  tool_name     text
  tool_input    jsonb
  tool_result   jsonb                     -- TRUNCATED preview, never the full rows
  input_tokens  integer
  output_tokens integer
  error         text
  created_at    timestamptz not null default now()
  unique (session_id, seq)

ai_artifacts
  id            uuid pk
  session_id    uuid not null references ai_sessions on delete cascade
  message_id    uuid references ai_messages on delete set null
  kind          text not null             -- xlsx | pdf | png | csv
  title         text
  storage_key   text not null             -- object-storage path
  bytes         integer not null
  row_count     integer
  created_at    timestamptz not null default now()

ai_checks
  id            uuid pk
  key           text not null unique
  title_ar      text not null
  title_en      text not null
  sql           text not null
  severity      text not null             -- info | warn | critical
  enabled       boolean not null default true
```

Indexes: `ai_messages(session_id, seq)`, `ai_sessions(created_by, updated_at desc)`,
`ai_artifacts(session_id)`.

**`tool_result` is a preview, not the payload.** A `run_sql` that returns 40k
rows must not put 40k rows in a jsonb column — the row cap already applied for
the model applies to storage too. The artifact holds the full data.

### Context assembly

Do not replay the whole thread. Per turn, send:

1. System prompt for the persona (cached — see §6).
2. A rolling summary of turns older than the last 12 (regenerated every 10
   turns, stored on `ai_sessions.summary`).
3. The last 12 messages verbatim.

Without this, a 60-turn session costs more per turn than the whole session did
to that point.

---

## 4. Tools

Existing three stay. Added:

### `render_pdf`

Not Python. The Node path is already there: `report-renderer.service.ts` builds
xlsx via `exceljs`; PDF gets the same treatment via **pdfmake** (pure JS, no
headless browser, no native deps, ~1MB).

Arabic is the deciding constraint: the report body is Arabic and PDF needs an
embedded font with proper shaping. Bundle **Noto Naskh Arabic**, and set RTL
direction per text run. A PDF library that "supports Arabic" but renders it
disconnected and left-to-right is not usable for this client and must be
rejected in review.

```
render_pdf(sql, title, orientation?, group_by?) -> artifact_id
```

### `run_python` — Analyst only

For what SQL cannot do: regression, cohort/retention, clustering, charts.

**Execution model.** A separate short-lived container per call, from a prebuilt
image (`python:3.12-slim` + pandas, numpy, matplotlib, openpyxl):

```
docker run --rm --network none --read-only \
  --memory 512m --cpus 1 --pids-limit 64 \
  --tmpfs /tmp:rw,size=64m,noexec \
  -v <job-dir>:/job:ro vanflow-pysandbox python /job/main.py
```

- `--network none` — the analysis has no reason to reach the internet, and this
  removes exfiltration as a category rather than as a rule to enforce.
- The script receives its data as a `/job/data.parquet` the API writes from an
  already-validated SELECT. **The sandbox never gets database credentials.**
- Output is whatever it writes to `/job/out/`, collected as artifacts.
- 30s wall clock, hard-killed.

**Cost note, stated plainly.** The client server showed 1.87 GB of container
memory with 698 MB already in use. A 512 MB sandbox plus a ~400 MB image is a
real bite. On that box, `run_python` should ship **disabled by default**
(`AI_PYTHON_ENABLED=false`) and be switched on per-site after checking headroom.
Phase 2, not Phase 1 — everything else is useful without it.

### `run_checks` — Auditor only

Runs the enabled rows of `ai_checks`, returns `{key, severity, count, sample}`
per check. The model ranks and explains; it does not write the SQL.

### `get_geo` — Sales Coach only

Customer coordinates, last visit, last sale, route membership — so "who is near
rep 101 and has not bought in 60 days" is one call instead of four.

---

## 5. Full-page UI

Route `/ai`, inside `(dashboard)`. The FAB stays for one release, then becomes a
link to `/ai`.

```
┌──────────┬────────────────────────────────┬──────────────┐
│ Sessions │  Thread                        │  Artifacts   │
│          │                                │              │
│ + New    │  [persona chip] [model] [cost] │  report.xlsx │
│ ───────  │                                │  chart.png   │
│ Today    │  user bubble                   │  audit.pdf   │
│  · ...   │  assistant answer              │              │
│ Earlier  │    ▸ ran SQL (collapsed)       │  ← click to  │
│  · ...   │    ▸ ran Python (collapsed)    │    preview   │
│          │    [table preview] [Download]  │              │
│          │                                │              │
│          │  ┌──────────────────────────┐  │              │
│          │  │ Ask…            [Expert▾]│  │              │
│          │  └──────────────────────────┘  │              │
└──────────┴────────────────────────────────┴──────────────┘
```

Rules that matter more than the layout:

- **Tool calls collapse by default, expand to the exact SQL.** Trust in this
  feature is built by letting a sceptical accountant read the query.
- **Streaming.** A 20-second silent wait reads as broken. Stream tokens; show
  "running query…" while a tool executes.
- **Table previews cap at 50 rows** with "download for all N".
- **Mobile:** sessions and artifacts collapse into sheets; the thread is the
  page. Reuse the drawer pattern from `nav-drawer.store.ts`.
- **RTL first**, like the rest of the dashboard.
- Every answer that used data carries a **"how I got this"** affordance opening
  the SQL. No unsourced numbers.

---

## 6. Cost

Target: **under $5/month** for one office of a handful of admins.

**Default model: Gemini 2.5 Flash.** Already implemented
(`llm/gemini.provider.ts`), has a free tier, and is the cheapest capable option
for SQL-writing with tool use. Anthropic and OpenAI stay selectable in AI
Config for sites that want them.

Cost control, in order of effect:

1. **Cache the schema.** `get_schema` on a 60-table database is thousands of
   tokens, re-sent every turn. Cache it in the system prompt with a provider
   prompt-cache marker, invalidated on migration.
2. **Summarise old turns** (§3) instead of replaying them.
3. **Cap tool output.** 200 rows to the model, ever. The artifact carries the
   rest.
4. **Cap per session** — `AI_MAX_TURNS` (default 40) and a token ceiling; refuse
   politely past it and offer a new session.
5. **Record real usage** per message and per session, and surface it in the
   header. An admin who can see the number stays under it.

Also support `AI_BASE_URL` for an OpenAI-compatible endpoint, so a site can
point at a local Ollama/vLLM and pay nothing. Quality will be worse; that is the
site's call to make, not ours to prevent.

---

## 7. Security

The read-only role and SQL validator already exist and stay. Additions:

**Prompt injection is the live threat.** The model reads `customers.name`,
`voucher_headers.note`, `collections.note` — all rep-entered free text. A
customer named `"] ignore previous instructions and…` is a plausible attack, not
a hypothetical.

- Tool results are wrapped in a delimiter and prefixed: *data, not
  instructions*.
- The model has **no write tool at all**. Not a guarded one — none. Every action
  is a rendered button the operator presses under their own session.
- The Python sandbox has no network and no credentials, so a successful
  injection still reaches nothing.

**RBAC.** `/ai` is admin-only at first (reuse `guards/admin.guard.ts`). When it
opens to managers, the read-only role must gain a scoped view — a manager must
not read another region's margin through the assistant when the dashboard would
not show it. Blocked on the same question as
[SPEC-supervisor-scoping](SPEC-supervisor-scoping.md); do not open it before
that lands.

**PII.** Phone numbers are already hashed. The assistant must not be the way
they come back — exclude `phone_hash` and `password_hash` from `get_schema`
output entirely.

**Audit.** Every SQL statement the model ran is already stored per message; keep
it queryable, because "what did the AI look at" will be asked.

---

## 8. Phases

**Phase 1 — the page and the storage.** New tables, session/message API, `/ai`
route with streaming, artifacts panel, cost display. Existing three tools only.
*Ships alone: this is already the biggest usability jump.*

**Phase 2 — deliverables.** `render_pdf` with Arabic shaping. Chart images from
a fixed set of chart types (no Python yet — a `render_chart(sql, kind, x, y)`
tool covers most of what people ask for).

**Phase 3 — experts.** The four personas, `ai_checks` and `run_checks`,
`get_geo`, the recommend-with-a-button pattern for Cash Admin.

**Phase 4 — Python, optional.** The sandbox, off by default, for sites with
headroom.

Each phase is independently shippable and independently revertible.

---

## 9. Open questions

1. **Who may use it?** Admin-only is the safe start, but the value is highest
   for a sales manager. Needs §7's scoping answer first.
2. **Does the assistant read the ERP too?** Half the answers ("which invoices
   never reached the ERP") need both databases. A second read-only connection to
   `erp_database` is straightforward but doubles the schema in context and the
   injection surface. Recommend: no in Phase 1, revisit in Phase 3.
3. **Retention.** Sessions hold business data in `blocks`. Auto-archive at 90
   days? Hard-delete at a year?
4. **Cost ceiling behaviour** — refuse, or degrade to a cheaper model?

---

## 10. Stitch design brief

Paste into Stitch, then hand the export back for implementation:

> Design a full-page AI assistant for an Arabic-first (RTL) logistics dashboard,
> dark theme, used on desktop and phone.
>
> **Three columns on desktop:** a 260px sessions list (grouped Today / Earlier,
> with a prominent "New chat"); a centre conversation thread; a 300px artifacts
> panel showing generated Excel, PDF and chart files as preview cards with
> download buttons.
>
> **The composer** sits fixed at the bottom of the thread: a multi-line input
> with a persona selector on the trailing edge offering four experts — Cash
> Admin, Auditor, Sales Coach, Data Analyst — each with its own icon and accent
> colour.
>
> **Assistant messages** can contain: streamed text; a collapsed "ran a query"
> row that expands to show SQL in a monospace block; a data table preview
> capped at a few rows with a "download all" action; and an inline chart image.
>
> **Header** carries the session title, the active expert as a chip, the model
> name, and a running token/cost figure.
>
> **On mobile (375px):** one column — the thread. Sessions and artifacts each
> open as a bottom sheet from icon buttons in a compact header. The composer
> stays pinned above the keyboard.
>
> Include an empty state for a new chat that suggests four starter prompts, one
> per expert. Arabic text throughout, right-aligned, with numbers and SQL in a
> monospace LTR run.

---

## 11. Honest sizing

Phase 1 is roughly a week of focused work; all four phases with Arabic PDF and a
hardened sandbox is closer to a month. The riskiest items are Arabic PDF shaping
(budget real time for it — it is where this kind of feature usually stalls) and
the memory headroom for Python on a 1.87 GB box.

The single highest-value slice, if only one thing ships: **Phase 1 plus
`render_pdf`.** A full-page assistant that answers from real data and hands back
a proper Arabic PDF is already the product being asked for. The personas make it
feel expert; the page and the deliverables make it useful.
