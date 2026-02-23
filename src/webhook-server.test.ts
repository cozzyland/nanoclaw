import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_OWNER_JID = process.env.NANOCLAW_OWNER_JID;

afterEach(() => {
  if (ORIGINAL_OWNER_JID === undefined) {
    delete process.env.NANOCLAW_OWNER_JID;
  } else {
    process.env.NANOCLAW_OWNER_JID = ORIGINAL_OWNER_JID;
  }
  vi.resetModules();
});

describe('startWebhookServer', () => {
  it('throws if NANOCLAW_OWNER_JID is missing', async () => {
    delete process.env.NANOCLAW_OWNER_JID;
    const { startWebhookServer } = await import('./webhook-server.js');

    expect(() => {
      startWebhookServer(
        3004,
        'secret',
        vi.fn(),
        vi.fn(async () => {}),
      );
    }).toThrow(/NANOCLAW_OWNER_JID/);
  });
});
