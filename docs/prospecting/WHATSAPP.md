# WhatsApp outreach via OpenWA

Sending quote links to prospects goes through a **self-hosted
[OpenWA](https://github.com/rmyndharis/OpenWA) gateway** — a NestJS service that
drives a WhatsApp Web session and exposes a REST API. The VanFlow backend never
embeds the WhatsApp library; it only calls the gateway over HTTP.

```
dashboard ──► VanFlow API ──► OpenWA gateway ──► WhatsApp
              (pacing, cap)   (session, QR)
```

## Read this before enabling it

OpenWA automates an **unofficial** WhatsApp session. From its own documentation:

> Sending the first-ever message to a large batch of numbers that have never
> messaged you is the single most reliable way to get restricted.

That is precisely what prospecting does — the numbers come from Google Places and
have never contacted you. A restricted number **cannot be recovered**; the only
route is WhatsApp's own appeal process.

Practical consequences:

- Use a **dedicated number**, never the company's main line.
- **Warm it up** for several days first: exchange real messages with saved
  contacts, join a group, set a profile photo.
- Keep the pacing defaults. The backend serializes sends with a ≥20 s gap plus
  jitter and stops at 150/day; both are enforced in `WhatsappService`, so no UI
  path can bypass them.
- The official, ban-proof alternative is the **WhatsApp Cloud API** (Meta), which
  requires business verification and per-conversation fees. If outreach volume
  ever matters commercially, that is the migration target — `WhatsappService` is
  the only file that would change.

When the gateway is off, the dashboard falls back to **wa.me click-to-chat**: the
chat opens prefilled and a human presses Send. Slower, but zero ban risk.

## Running the gateway

Add to the deployment's `docker-compose.yml`:

```yaml
  openwa:
    image: ghcr.io/rmyndharis/openwa:latest
    container_name: openwa
    environment:
      ENGINE_TYPE: whatsapp-web.js   # lower ban-risk than baileys
      API_KEY: ${WHATSAPP_API_KEY}
    volumes:
      - openwa_sessions:/app/sessions   # survives restarts; avoids re-scanning
    networks: [cashvan-net]
    restart: always
    # Publish ONLY if you need the QR dashboard from outside the host.
    ports:
      - "2785:2785"

volumes:
  openwa_sessions:
```

Then, once:

1. Open `http://<host>:2785` and create a session named `sales`.
2. Start it, fetch the QR, and scan it from the dedicated phone.
3. Confirm the session reads `CONNECTED`.

## Backend configuration

In the `.env` next to `docker-compose.yml` (the `api` service reads it via
`env_file`, so **no image rebuild is needed**):

```
PUBLIC_DASHBOARD_URL=http://77.245.5.113:3001
WHATSAPP_GATEWAY_URL=http://openwa:2785
WHATSAPP_API_KEY=<same value as the gateway's API_KEY>
WHATSAPP_SESSION_ID=sales
WHATSAPP_COUNTRY_CODE=962
WHATSAPP_MIN_INTERVAL_MS=20000
WHATSAPP_DAILY_CAP=150
```

`PUBLIC_DASHBOARD_URL` is required — it builds the `/q/<token>?p=<prospectId>`
link carried in the message, which is also what powers open-tracking. It is read
from config, never from the request, so a caller cannot make the company number
send a link pointing somewhere else.

Apply with:

```bash
docker compose up -d api openwa
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/prospecting/whatsapp/status` | configured / reachable / session state / daily budget |
| `POST` | `/api/v1/prospecting/prospects/:id/send-whatsapp` | send the quote, then mark the lead `CONTACTED` |

The send body accepts only an optional `templateId`. The message **text** is
composed server-side from that template, so the endpoint cannot be used to push
arbitrary content out of the company's number.

Failure modes are mapped to actionable errors rather than a generic 500:

| Situation | Response |
|---|---|
| Gateway URL/session unset | `503` "not configured" |
| Wrong API key | `503` "rejected the API key" |
| Session not scanned / disconnected | `503` "re-scan the QR code" |
| Daily cap hit | `429` with the cap in the message |
| Lead has no phone / is already a customer | `400` |

## Verifying without risking a number

`src/modules/prospecting/whatsapp.spec.ts` covers chatId normalization
(`07 7212 8611` → `962772128611@c.us`), send serialization, the daily cap, and
error mapping — all against a mocked gateway. For an end-to-end check, point
`WHATSAPP_GATEWAY_URL` at a stub HTTP server that logs what it receives; the
whole chain runs without a WhatsApp account attached.
