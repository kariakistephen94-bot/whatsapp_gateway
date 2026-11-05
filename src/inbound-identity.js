function phoneJid(value) {
  if (typeof value !== 'string') return null;
  const match = /^([1-9]\d{6,14})(?::\d+)?@s\.whatsapp\.net$/.exec(value);
  return match ? `${match[1]}@s.whatsapp.net` : null;
}

export async function resolveInboundIdentity(key = {}, lidMapping) {
  const original = typeof key.remoteJid === 'string' ? key.remoteJid : '';
  // Never turn a group message into a direct contact using its participant's alternate ID.
  if (key.participant || !original || original.endsWith('@g.us')) return {from: original, resolved: false};
  const direct = phoneJid(original);
  if (direct) return {from: direct, resolved: true, source: 'phone_jid'};
  if (!/^\d+(?::\d+)?@lid$/.test(original)) return {from: original, resolved: false};
  const alternate = phoneJid(key.remoteJidAlt);
  if (alternate) return {from: alternate, resolved: true, source: 'provider_alternate'};
  try {
    const mapped = phoneJid(await lidMapping?.getPNForLID?.(original));
    if (mapped) return {from: mapped, resolved: true, source: 'provider_mapping'};
  } catch { /* Unresolved identifiers remain unresolved; never guess a phone number. */ }
  return {from: original, resolved: false};
}
