// HTTP statuses that mean "this payload will never be accepted"; everything else non-2xx is retried
// (404/401/5xx are usually a receiver that is not deployed or configured yet).
const PERMANENT = new Set([400, 413, 422]);

/**
 * Build the outbox `send` function: POST one event as JSON with the status-webhook secret.
 * Error strings returned here end up in logs, so they never include the URL, headers or body.
 */
export function createWebhookSender({ url, secret, timeoutMs = 10_000, fetchImpl = fetch }) {
  return async function sendStatusEvent(event) {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        redirect: 'manual', // never forward the secret to a redirect target
        headers: {
          'content-type': 'application/json',
          'x-helios-gateway-key': secret,
          'x-helios-event-id': event.event_id,
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const why = e?.name === 'TimeoutError' ? 'timeout' : (e?.cause?.code || e?.code || 'request failed');
      return { ok: false, error: `network: ${why}` };
    }
    try { await res.body?.cancel(); } catch { /* body already consumed */ }

    if (res.status >= 200 && res.status < 300) return { ok: true };
    if (res.status >= 300 && res.status < 400) return { ok: false, error: `http ${res.status} (redirects are not followed)` };
    return { ok: false, error: `http ${res.status}`, permanent: PERMANENT.has(res.status) };
  };
}
