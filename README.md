# WhatsApp Gateway (self-hosted, no Meta API)

A small Node backend that links to **your own WhatsApp account** as a "linked device"
(the same way WhatsApp Web does) using [Baileys](https://github.com/WhiskeySockets/Baileys),
and exposes a REST API to send messages.

## Run

```bash
npm install
cp .env.example .env      # set API_KEY to a long random string
export $(grep -v '^#' .env | xargs)   # or use your process manager's env support
npm start
```

## Pair your phone (once)

1. Open `http://localhost:3000/qr?key=YOUR_API_KEY`
2. WhatsApp → Settings → **Linked devices** → **Link a device** → scan.

The session is saved in `AUTH_DIR` (`./auth_state`), so restarts reconnect automatically.
**Treat that folder like a password** — anyone with it can act as you on WhatsApp.

## API

All routes except `/health` need `Authorization: Bearer <API_KEY>` (or `x-api-key`).

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/status` | – | Connection state |
| GET | `/qr` | – | Pairing QR page |
| POST | `/send` | `{ "to": "2348012345678", "text": "Hi" }` | Send text |
| POST | `/send` | `{ "to": "...", "media": { "url" or "base64", "mimetype", "fileName?", "caption?" } }` | Send image/video/audio/doc |
| POST | `/send-bulk` | `{ "messages": [{ "to", "text" }] }` | Up to 50, sent sequentially |
| POST | `/check` | `{ "numbers": ["234..."] }` | Which numbers are on WhatsApp |
| GET | `/messages?limit=50` | – | Recent inbound messages (in-memory) |
| GET | `/status-events` | – | Status-forwarding outbox health + dead events |
| POST | `/status-events/retry-dead` | – | Re-queue status events that exhausted their retries |
| POST | `/logout` | – | Unlink this device |

`to` can be a phone number with country code (no `+`), a full JID, or a group JID (`1203...@g.us`).

```bash
curl -X POST localhost:3000/send \
  -H "Authorization: Bearer $API_KEY" -H "content-type: application/json" \
  -d '{"to":"2348012345678","text":"Hello from my gateway"}'
```

Set `WEBHOOK_URL` to have inbound messages POSTed to your own service.

## Delivery & read status

Set `STATUS_WEBHOOK_URL` and `STATUS_WEBHOOK_SECRET` to have `sent` / `delivered` / `read` / `failed`
updates for messages you send POSTed to your own service (header `X-Helios-Gateway-Key`), through a durable,
retrying outbox. Separate from `WEBHOOK_URL`; it can't cause replies. Read receipts depend on the
recipient's privacy settings, and a missing receipt is never reported as a failure.
Event format, retry behavior and limitations: [docs/status-webhook.md](docs/status-webhook.md).
Tests: `npm test`.

## Important caveats

- **Unofficial.** This isn't sanctioned by WhatsApp/Meta and technically violates their ToS.
  Personal-scale use is generally fine; **bulk, cold, or spammy messaging can get your number banned.**
  Use a number you can afford to lose for anything high-volume. Sends are throttled
  (`MIN_SEND_INTERVAL_MS`) to reduce risk.
- The protocol can change without notice; keep Baileys updated.
- Don't expose this publicly without TLS and a strong `API_KEY`. It binds to `127.0.0.1` by default.
- Run a single instance per session; running two against the same `auth_state` will fight.
