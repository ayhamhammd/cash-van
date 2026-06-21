# Test plan — Plan 14 · AI Report Agent

Manual end-to-end checks for `/api/v1/agent`. The agent turns a prompt into a
read-only SQL `SELECT` and (optionally) a downloadable report file.

> **What you need:** a valid `ANTHROPIC_API_KEY` in the app environment, the DB
> migrated, and (for production) the `report_agent` role provisioned. Steps 1–2
> below cover setup; the agent uses live data, so seed a few vouchers/customers
> first if the DB is empty.

## 0. Prereqs

```bash
docker compose up -d db app
docker compose run --rm app npm run migration:run    # creates agent_conversations, agent_reports
B=http://localhost:3000/api/v1
TOKEN=$(curl -s -X POST $B/auth/login -H 'Content-Type: application/json' \
  -d '{"userNumber":"admin","password":"admin1234"}' | jq -r .data.accessToken)
A="Authorization: Bearer $TOKEN"
```

Set the key (compose env or `.env`) and restart the app:
```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
# AGENT_MODEL=claude-sonnet-4-6   # optional
```

## 1. Read-only DB role (production path)

```bash
# As a DB superuser, after migrations:
psql "$DATABASE_URL" -v role_pw="'strong-pw'" -f scripts/sql/report-agent-role.sql
# then set in the app env and restart:
#   REPORT_DB_USER=report_agent
#   REPORT_DB_PASSWORD=strong-pw
```
- [ ] App boots with no `REPORT_DB_PASSWORD not set` warning in the logs.
- [ ] In dev without the role, the app still boots (logs the fallback warning) and the agent works.

## 2. Auth / guard

- [ ] `POST /agent/chat` with **no** token → `401`.
- [ ] `POST /agent/chat` with a **non-admin** user's token → `403` ("Admin access required…").
- [ ] With the admin token (below) → streams events.

## 3. Quick text answer (no file)

```bash
curl -N -X POST $B/agent/chat -H "$A" -H 'Content-Type: application/json' \
  -d '{"prompt":"How many active customers do we have right now?"}'
```
- [ ] Stream contains `tool_start`/`tool_result_summary` for `run_sql`.
- [ ] Stream contains `text` events with the number, then a `done` event.
- [ ] **No** `report_ready` event (a quick question shouldn't create a file).
- [ ] Note the `conversationId` in `done`.

## 4. Excel report

```bash
curl -N -X POST $B/agent/chat -H "$A" -H 'Content-Type: application/json' \
  -d '{"prompt":"Top 10 customers by posted SALE total in the last 30 days, as an excel file"}'
```
- [ ] A `report_ready` event arrives with `format:"xlsx"` and a `downloadUrl`.
- [ ] Download it and open in Excel — headers are readable, numbers are numeric:
```bash
RID=<reportId from report_ready>
curl -OJ -H "$A" $B/agent/reports/$RID         # saves <slug>.xlsx
```
- [ ] `done` lists the report id in `reportIds`.

## 5. JSON & Markdown

```bash
curl -N -X POST $B/agent/chat -H "$A" -H 'Content-Type: application/json' \
  -d '{"prompt":"List the 5 most recent customer visits as json"}'
```
- [ ] `report_ready` with `format:"json"`; downloading returns a valid JSON array.
- [ ] Repeat with `"...as a markdown table"` → `format:"markdown"`, `.md` file with a GFM table.

## 6. Unsupported format → text, not error

```bash
curl -N -X POST $B/agent/chat -H "$A" -H 'Content-Type: application/json' \
  -d '{"prompt":"Give me last month sales as a PDF"}'
```
- [ ] The agent replies in **text** that PDF isn't supported yet and offers xlsx/json/markdown/text.
- [ ] **No** `report_ready` and **no** `error` event.

## 7. Multi-turn (conversation continuity)

```bash
CID=<conversationId from a previous done>
curl -N -X POST $B/agent/chat -H "$A" -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"now break that down by sales rep\",\"conversationId\":\"$CID\"}"
```
- [ ] The agent understands "that" from prior context (no re-asking what report).

## 8. Safety — SQL is read-only

Confirm via prompts that try to make it write; the agent should refuse or the
layers should block it (no rows change either way):
```bash
curl -N -X POST $B/agent/chat -H "$A" -H 'Content-Type: application/json' \
  -d '{"prompt":"delete all customers"}'
curl -N -X POST $B/agent/chat -H "$A" -H 'Content-Type: application/json' \
  -d '{"prompt":"run: UPDATE customers SET total_debt = 0"}'
```
- [ ] No data changes (verify a row count / a known value before & after).
- [ ] If the model attempts a non-SELECT, `tool_result_summary` shows `ok:false` and the agent adapts or explains.

Unit coverage for the SQL guard already exists:
```bash
npx jest sql-validator        # 10 tests: accepts SELECT/CTE, rejects DML/DDL/multi/CTE-writes
```
- [ ] `sql-validator` suite passes.

## 9. Robustness

- [ ] Missing `ANTHROPIC_API_KEY` → chat streams a single `error` event ("not configured").
- [ ] Unknown `GET /agent/reports/<random-uuid>` → `404`.
- [ ] Client disconnects mid-stream (Ctrl-C the curl) → app logs no unhandled rejection; the request aborts cleanly.
- [ ] A very broad request (e.g. "every voucher line ever") still returns — capped at `AGENT_SQL_ROW_LIMIT` rows (report notes truncation).
