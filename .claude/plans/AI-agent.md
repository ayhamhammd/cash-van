STACK: NestJS (TypeScript), not Python.
- @anthropic-ai/sdk           the LLM client + tool-use loop
- pg                          PostgreSQL driver (use a Pool)
- node-sql-parser             SQL validation/parsing (set database: 'postgresql')
- exceljs                     xlsx rendering
- pdfkit                      pdf rendering
- csv-stringify               csv; JSON.stringify for json
- better-sqlite3              conversation history (no external service)
- @nestjs/config              env config
- SSE: Nest's native @Sse() decorator returning an Observable<MessageEvent>

NEST STRUCTURE (maps onto the clean layout from the main spec):
  src/agent/      AgentService (the tool-use loop) + system prompt
  src/agent/agent.controller.ts   POST /chat (@Sse), GET /reports/:id
  src/tools/      get-schema, run-sql, generate-report tool handlers
  src/db/         ReadonlyDbService — pg Pool as the report_agent role
  src/reports/    renderer services (xlsx, pdf, csv, json)
  src/store/      ConversationStore (better-sqlite3)
  src/config/     env schema + validation
  src/auth/       a Guard that checks Authorization: Bearer ADMIN_BEARER_TOKEN

TYPESCRIPT-SPECIFIC NOTES:
- Define the tools as a typed array matching the SDK's Tool[] shape, each with
  a JSON-schema input_schema. Keep the loop in AgentService: call
  client.messages.create({ model, tools, messages }), inspect stop_reason; while
  it's "tool_use", run the matching handler, push a tool_result content block,
  call again. Cap at 8 iterations.
- node-sql-parser: parse with { database: 'PostgreSQL' }. Reject if the AST is
  not exactly one node, or its type !== 'select'. astify throwing IS a rejection
  (malformed/multi-statement) — catch and treat as invalid.
- ReadonlyDbService: on each pooled connection run
  `SET default_transaction_read_only = on; SET statement_timeout = 15000;`
  then run the query inside a transaction and ROLLBACK after reading.
- @Sse() streams MessageEvents; emit the same events from the main spec
  (text delta, tool_start, tool_result_summary, report_ready, done). Build the
  synchronous loop first, add the Observable/SSE layer second.
- better-sqlite3 is synchronous by design — fine here, keep store calls simple.