import path from 'node:path';
import { Journal } from './journal.js';
import { StatusOutbox } from './outbox.js';
import { StatusTracker } from './tracker.js';
import { createWebhookSender } from './webhook.js';
import { loadStatusConfig } from './config.js';

/**
 * Wire status tracking + the durable outbox to a WhatsAppClient.
 * Returns null when STATUS_WEBHOOK_URL is not configured. Throws on invalid configuration.
 *
 * This is deliberately independent of the inbound-message path: it listens to the client's
 * 'outbound-sent' / 'outbound-status' events only, and has no way to send a WhatsApp message.
 */
export function createStatusPipeline({ env, logger, fetchImpl }) {
  const config = loadStatusConfig(env);
  if (!config) return null;

  const outbox = new StatusOutbox({
    journal: new Journal(path.join(config.dataDir, 'status-outbox.jsonl')),
    send: createWebhookSender({ url: config.url, secret: config.secret, timeoutMs: config.timeoutMs, fetchImpl }),
    maxAttempts: config.maxAttempts,
    baseDelayMs: config.baseDelayMs,
    maxDelayMs: config.maxDelayMs,
    logger,
  });
  const tracker = new StatusTracker({
    journal: new Journal(path.join(config.dataDir, 'status-ledger.jsonl')),
    outbox,
    ttlMs: config.ledgerTtlMs,
    logger,
  });

  let pruneTimer = null;
  const guarded = (fn) => (arg) => {
    try { fn(arg); } catch (e) { logger.error({ err: e.message }, 'status tracking error'); }
  };

  return {
    config,
    outbox,
    tracker,

    attach(wa) {
      wa.on('outbound-sent', guarded((m) => tracker.registerSent(m)));
      wa.on('outbound-status', guarded((u) => tracker.handleProviderUpdate(u)));
    },

    start() {
      for (const w of config.warnings) logger.warn(w);
      outbox.load();
      tracker.load();
      outbox.start();
      pruneTimer = setInterval(guarded(() => tracker.prune()), 6 * 3_600_000);
      pruneTimer.unref();
      logger.info({ url: config.displayUrl, ...outbox.stats() }, 'status forwarding enabled');
    },

    async stop() {
      clearInterval(pruneTimer);
      await outbox.stop();
      tracker.journal.close();
    },
  };
}
