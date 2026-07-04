# API — Plan 14 · AI Report Agent (`/api/v1/agent`)

A natural-language reporting assistant. You send a prompt ("top 10 customers by
sales this month as excel"); the agent inspects the database schema, writes a
**read-only** SQL `SELECT`, and either answers in text or renders a downloadable
report file (xlsx / json / markdown / text).

Base URL: `/api/v1/agent`. **ADMIN only** — every endpoint requires
`Authorization: Bearer <jwt>` for a user whose `userType` is `ADMIN` (non-admins
get `403`).

> **Envelope note:** the chat endpoint is a raw **SSE stream** (not the
> `{ success, data }` envelope). The report-download endpoint returns the file
> bytes. Only ordinary errors (auth, 404) use the standard error envelope.

---

## How it works (architecture)

```
prompt ──► AgentService (Claude tool-use loop, max 8 iterations)
              │  tools:
              │   • get_schema      → tables + columns (information_schema)
              │   • run_sql         → validate + run one SELECT, preview rows
              │   • generate_report → run SELECT, render file, store, return link
              ▼
        SQL validator (node-sql-parser, SELECT-only, single statement, no
        data-modifying CTEs) ──► ReadonlyDbService (separate `report_agent`
        pg pool, READ ONLY tx + statement_timeout, always ROLLBACK)
```

Three layers guard the model-generated SQL: (1) the parser rejects anything that
isn't a single `SELECT`; (2) the query runs as a SELECT-only Postgres role; (3)
it runs inside a `READ ONLY` transaction with a timeout that is always rolled
back. A default `LIMIT` is appended when the query has none.

---

## LLM provider (Claude or Gemini)

The agent is provider-agnostic behind a small abstraction (`src/modules/agent/llm/`).
Pick the vendor with `LLM_PROVIDER`:

| `LLM_PROVIDER` | Key | Model env | Notes |
|---|---|---|---|
| `anthropic` (default) | `ANTHROPIC_API_KEY` | `AGENT_MODEL` (`claude-sonnet-4-6`) | Most reliable SQL/tool use; data never used for training. |
| `gemini` | `GEMINI_API_KEY` | `GEMINI_MODEL` (`gemini-2.5-flash`) | Has a free tier. ⚠️ free-tier inputs may be used by Google to improve their products — don't use it for sensitive data; use a paid/Vertex key for that. |

Only the selected provider's key is required; if it's missing the chat endpoint
streams a single `error` event. Switching is a config change + restart — no code
change. Both go through the same tool-use loop, SQL guard and renderer.

## Setup (one-time per deployment)

1. **LLM key** — set `LLM_PROVIDER` and the matching key (`ANTHROPIC_API_KEY` or
   `GEMINI_API_KEY`). Without a key the chat endpoint streams a single `error` event.
2. **Read-only DB role** — run [`scripts/sql/report-agent-role.sql`](../../scripts/sql/report-agent-role.sql)
   once as a superuser, then set `REPORT_DB_USER` / `REPORT_DB_PASSWORD`.
   In development you may leave `REPORT_DB_PASSWORD` blank — the agent falls back
   to the main DB login (the read-only transaction is still enforced).
3. **Migration** — `npm run migration:run` creates `agent_conversations` and
   `agent_reports`.

All tunables (`AGENT_*`, `REPORT_DB_*`) are documented in [`.env.example`](../../.env.example).

---

## POST `/agent/chat` — chat with the agent (SSE)

Streams the agent's response as **Server-Sent Events over POST**. Consume it with
a streaming `fetch` reader (browsers' `EventSource` can't POST a body).

**Request body** (`ChatDto`):
| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string (1–4000) | ✅ | The report request / question |
| `conversationId` | uuid | — | Continue a thread (from a previous `done` event). Omit to start fresh |

**Response:** `Content-Type: text/event-stream`. Each event is
`event: <type>\ndata: <json>\n\n`. Event types:

| `event:` | `data` payload | Meaning |
|---|---|---|
| `text` | `{ delta }` | A chunk of the assistant's text answer — concatenate in order |
| `tool_start` | `{ id, name, input }` | The agent invoked a tool (`get_schema` / `run_sql` / `generate_report`) |
| `tool_result_summary` | `{ id, name, ok, summary }` | That tool finished (`ok:false` = it errored, agent will adapt) |
| `report_ready` | `ReportRef` (below) | A report file was generated and stored |
| `done` | `{ conversationId, reportIds, stopReason }` | Turn complete. Reuse `conversationId` for follow-ups |
| `error` | `{ message }` | Fatal error for this turn |

**`ReportRef`** (the `report_ready` payload):
```json
{
  "reportId": "f1e2...uuid",
  "title": "Top 10 customers — June",
  "format": "xlsx",
  "filename": "top-10-customers-june.xlsx",
  "rowCount": 10,
  "downloadUrl": "/api/v1/agent/reports/f1e2...uuid"
}
```

### Supported formats
`text`, `markdown`, `json`, `xlsx`.
- **text** → the agent just answers in the `text` stream (no file).
- **markdown / json / xlsx** → the agent calls `generate_report`; a file is
  stored and a `report_ready` event is emitted.
- Any other format (csv, pdf, docx, …) → the agent replies in **text** that the
  format isn't supported yet (no tool call, no error event).

### Example (curl)
```bash
curl -N -X POST https://host/api/v1/agent/chat \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Top 10 customers by posted sales in the last 30 days as an excel file"}'
```
```
event: tool_start
data: {"id":"toolu_01","name":"get_schema","input":{}}

event: tool_result_summary
data: {"id":"toolu_01","name":"get_schema","ok":true,"summary":"schema returned"}

event: tool_start
data: {"id":"toolu_02","name":"generate_report","input":{"sql":"SELECT ...","format":"xlsx","title":"Top 10 customers"}}

event: report_ready
data: {"reportId":"f1e2...","format":"xlsx","filename":"top-10-customers.xlsx","rowCount":10,"downloadUrl":"/api/v1/agent/reports/f1e2..."}

event: text
data: {"delta":"Here are your top 10 customers by sales. The Excel file is ready to download."}

event: done
data: {"conversationId":"9a8b...","reportIds":["f1e2..."],"stopReason":"end_turn"}
```

### Minimal browser client
```js
const res = await fetch('/api/v1/agent/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
  body: JSON.stringify({ prompt }),
});
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = '';
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  const frames = buf.split('\n\n');
  buf = frames.pop();                       // keep the partial frame
  for (const frame of frames) {
    const type = frame.match(/^event: (.*)$/m)?.[1];
    const data = JSON.parse(frame.match(/^data: (.*)$/m)?.[1] ?? '{}');
    if (type === 'text') appendText(data.delta);
    if (type === 'report_ready') showDownload(data);   // GET data.downloadUrl
  }
}
```

---

## GET `/agent/reports/{id}` — download a generated report

Streams the stored report file with its original content-type and filename
(`Content-Disposition: attachment`). `id` is the `reportId` from a `report_ready`
event. Returns `404` if unknown.

| Format | Content-Type | Extension |
|---|---|---|
| xlsx | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | `.xlsx` |
| json | `application/json` | `.json` |
| markdown | `text/markdown` | `.md` |
| text | `text/plain` | `.txt` |

```bash
curl -OJ -H "Authorization: Bearer $ADMIN_JWT" \
  https://host/api/v1/agent/reports/f1e2...uuid
```

---

## Limits & behaviour

| Setting | Env | Default |
|---|---|---|
| Model | `AGENT_MODEL` | `claude-sonnet-4-6` |
| Max output tokens / turn | `AGENT_MAX_TOKENS` | 4096 |
| Tool-use iterations / turn | `AGENT_MAX_ITERATIONS` | 8 |
| Rows previewed to the model | `AGENT_SQL_PREVIEW_ROWS` | 50 |
| Max rows in a report file | `AGENT_SQL_ROW_LIMIT` | 5000 |
| Per-query timeout | `AGENT_SQL_TIMEOUT_MS` | 15000 ms |

- Conversations and report metadata persist in Postgres; report bytes go to the
  configured object storage (`STORAGE_LOCAL_ROOT` by default).
- The agent is **read-only**: it can never write to the database, regardless of
  what a prompt asks.
