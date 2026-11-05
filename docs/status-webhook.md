# Delivery / read status webhook

The gateway reports what WhatsApp tells it about messages **it sent** to a separate endpoint
(`STATUS_WEBHOOK_URL`). This is independent of the inbound-message webhook (`WEBHOOK_URL`): different
URL, different secret, different code path. Status events never create inbound messages and nothing in
this path can send a WhatsApp message, so they cannot trigger auto-replies or loops.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `STATUS_WEBHOOK_URL` | – | Empty = feature off. Must not equal `WEBHOOK_URL`. Use `https` unless it is loopback. |
| `STATUS_WEBHOOK_SECRET` | – | Required with the URL. Min 16 chars, must differ from `API_KEY`. Sent as `X-Helios-Gateway-Key`. |
| `STATUS_DATA_DIR` | `./data` | Holds `status-outbox.jsonl` and `status-ledger.jsonl` (phone numbers inside; files are `0600`). Git-ignored. |
| `STATUS_WEBHOOK_TIMEOUT_MS` | `10000` | Per request. |
| `STATUS_MAX_ATTEMPTS` | `12` | Per event, then it is parked as *dead*. |
| `STATUS_RETRY_BASE_MS` / `STATUS_RETRY_MAX_MS` | `5000` / `900000` | Exponential backoff (x2, ±20 % jitter, capped). With defaults ≈ 1 hour of retries. |
| `STATUS_LEDGER_TTL_DAYS` | `30` | How long a sent message is remembered for late receipts. |

The gateway refuses to start if `STATUS_WEBHOOK_URL` is set with a missing/weak/duplicate secret.
Restart the gateway after changing these (the paired session in `AUTH_DIR` is reused; no re-pairing).

## Request

```
POST <STATUS_WEBHOOK_URL>
content-type: application/json
x-helios-gateway-key: <STATUS_WEBHOOK_SECRET>
x-helios-event-id: <same as body.event_id>
```

Body (one event per request):

```json
{
  "event_id": "gwevt_9f2c1a7e4b5d60a83c1e2f4a7b9d0c11",
  "event": "message_status",
  "provider": "linked_gateway",
  "message_id": "3EB0C767D0A1B2C3D4E5",
  "sender": "2348107920394",
  "recipient": "2349138314501",
  "status": "delivered",
  "occurred_at": "2026-11-01T12:00:07.000Z",
  "timestamp_source": "provider"
}
```

| Field | Meaning |
|---|---|
| `event_id` | `gwevt_` + hash of (sender, message_id, status). **Stable**: identical across retries, restarts and duplicate WhatsApp updates. Use it as the idempotency key. |
| `message_id` | The `id` returned by `POST /send` / `/send-bulk`. |
| `sender` / `recipient` | Digits only. `sender` is the linked number; `recipient` is the `to` the message was sent to (phone number, as recorded at send time). |
| `status` | `sent` · `delivered` · `read` · `failed` (see below). |
| `occurred_at` | ISO 8601 UTC. |
| `timestamp_source` | `provider` = WhatsApp's own receipt time. `observed` = the time the gateway saw the event (WhatsApp gave no usable timestamp). Provider times are never invented; values that are missing, ≤ 0, before 2015 or > 5 min in the future are treated as absent. |

**Response:** any `2xx` = accepted. Anything else is retried, except `400`, `413` and `422`, which are treated
as a payload problem and parked immediately. Redirects are **not** followed (the secret would travel with them).
`401/403/404/5xx` and network errors are retried, so deploying the receiver after the gateway is fine, within the
retry window; anything that expires can be re-queued (below).

## Statuses

| `status` | Source | Meaning |
|---|---|---|
| `sent` | Gateway, when `sendMessage` resolved | Handed to WhatsApp's servers. Always `timestamp_source: observed`. |
| `delivered` | WhatsApp delivery receipt | Reached the recipient's device. |
| `read` | WhatsApp read receipt (blue ticks), or "played" receipt for audio/video | Recipient's client reported it read/played. |
| `failed` | WhatsApp rejected the message (error ack/NACK) | Only explicit errors. **A missing receipt is never `failed`.** |

Rules the gateway applies (the receiver should apply the same ones, see "Receiver guidance"):

- Rank is `sent` < `delivered` < `read`. A status is emitted at most once per message and only if it is
  higher than anything already emitted. Late/duplicate `delivered` after `read` is dropped.
- A receipt can be skipped, e.g. `read` can arrive with no `delivered` event (WhatsApp batches/merges updates, or
  the recipient has delivery receipts off). The gateway does **not** synthesise the missing step.
- `failed` is dropped if the message was already `delivered` or `read`. If `delivered`/`read` arrives after
  `failed`, it is still emitted (a receipt is proof of delivery).
- Read state is **only** taken from WhatsApp's explicit receipt. Online presence, typing, timing, and replies are
  not used. A reply arrives as a normal inbound message through `WEBHOOK_URL`, separately.

## Receiver guidance

1. Verify `X-Helios-Gateway-Key` (constant-time compare) before parsing.
2. Deduplicate on `event_id`; respond `2xx` for duplicates.
3. Never move a message backwards: keep the highest of `sent < delivered < read` per `message_id`. Delivery is
   at-least-once, and although the gateway sends the events of one message in order, a request that timed out
   on the gateway side may still be processed late by the receiver, after a newer event. Keep `failed`
   separate from the rank: it only applies while no `delivered`/`read` has been seen.
4. Unknown `message_id` is possible (e.g. message sent before the receiver existed): accept and store or `2xx`-and-drop, don't `4xx` it.

## Operating the outbox

- Events are written to disk (fsync) *before* the first delivery attempt and survive crashes/restarts, with
  their `event_id`, body, attempt count and next-retry time. WhatsApp messages are never re-sent by the outbox.
- Delivery is at-least-once: a crash between a successful POST and the bookkeeping repeats the same event (same `event_id`).
- Events for the same message are sent in order. If the endpoint is failing, the whole queue pauses until the
  next retry time instead of hammering it.
- After `STATUS_MAX_ATTEMPTS` an event is *dead* (kept, max 1000). Authenticated endpoints (same `API_KEY` as the rest of the gateway):

```bash
curl -H "Authorization: Bearer $API_KEY" localhost:3000/status-events
# {"enabled":true,"pending":0,"dead":0,"oldest_pending_age_ms":null,"next_attempt_at":null,"dead_events":[]}

curl -X POST -H "Authorization: Bearer $API_KEY" localhost:3000/status-events/retry-dead
# {"ok":true,"requeued":3}
```

Logs contain event IDs, message IDs, statuses and error classes (`http 503`, `network: timeout`), never the
secret, request headers, bodies or the webhook URL's query string.

## Limitations

- **Read receipts are optional on WhatsApp.** If the recipient disabled read receipts you will get `delivered`
  and never `read`; that is normal and **not** a failure. Likewise a recipient who is offline or has the app
  closed stays at `sent` until their phone connects. There is no timeout that turns silence into `failed`.
- `sent` means "handed to WhatsApp", not "WhatsApp's server acknowledged it". A rejection can still follow as `failed`.
- 1:1 chats only. Groups, broadcast lists and newsletters have per-participant receipts and are not tracked.
- Only messages sent through this gateway (`/send`, `/send-bulk`) are tracked, and only after this feature is
  enabled. Messages sent earlier, or sent from the phone itself, produce no events.
- If WhatsApp merges updates before the gateway sees them (e.g. after a reconnect), intermediate statuses are skipped.
- Voice notes/video: a "played" receipt is reported as `read`.
- Baileys is an unofficial client (`@whiskeysockets/baileys 7.0.0-rc14`); receipt behavior can change with WhatsApp.
- Running two gateway instances against the same `AUTH_DIR`/`STATUS_DATA_DIR` is unsupported.
