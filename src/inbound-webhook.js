// Independent from the delivery/read status forwarder.
export function createInboundForwarder(env = process.env, request = fetch) {
  const raw = (env.WEBHOOK_URL || '').trim();
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid inbound webhook URL'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
    throw new Error('Inbound webhook requires HTTPS or local HTTP, without embedded credentials');
  }
  const secret = env.WEBHOOK_SECRET || '';
  if (secret.length < 16 || secret === env.API_KEY || secret === env.STATUS_WEBHOOK_SECRET) {
    throw new Error('Inbound webhook requires its own valid WEBHOOK_SECRET');
  }
  return async message => {
    let response;
    try {
      response = await request(url.href, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Helios-Key': secret },
        body: JSON.stringify(message),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error('Inbound webhook connection failed');
    }
    if (!response.ok) throw new Error(`Inbound webhook HTTP ${response.status}`);
    return { accepted: true };
  };
}
