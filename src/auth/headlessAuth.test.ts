// Headless CI authentication (INT-3101): OPENSWARM_AUTH_PROFILES env injection
// into the auth store, and the gpt adapter's OPENAI_API_KEY path.
import { afterEach, describe, expect, it, vi } from 'vitest';

const VALID_PROFILE = {
  type: 'apiKey',
  provider: 'openrouter',
  access: 'sk-or-test',
  refresh: '',
  expires: Number.MAX_SAFE_INTEGER,
  clientId: '',
};

async function freshStore() {
  vi.resetModules();
  const { AuthProfileStore } = await import('./oauthStore.js');
  return new AuthProfileStore();
}

describe('OPENSWARM_AUTH_PROFILES env injection', () => {
  afterEach(() => {
    delete process.env.OPENSWARM_AUTH_PROFILES;
  });

  it('exposes env-injected profiles through the store', async () => {
    process.env.OPENSWARM_AUTH_PROFILES = JSON.stringify({
      version: 1,
      profiles: { 'openrouter:default': VALID_PROFILE },
    });
    const store = await freshStore();
    expect(store.getProfile('openrouter:default')?.access).toBe('sk-or-test');
  });

  it('throws on invalid JSON instead of silently dropping the credential', async () => {
    process.env.OPENSWARM_AUTH_PROFILES = '{not json';
    await expect(freshStore()).rejects.toThrow(/not valid JSON/);
  });

  it('throws on a schema mismatch instead of silently dropping the credential', async () => {
    process.env.OPENSWARM_AUTH_PROFILES = JSON.stringify({
      version: 1,
      profiles: { 'openrouter:default': { provider: 'openrouter' } },
    });
    await expect(freshStore()).rejects.toThrow(/does not match the auth profile schema/);
  });

  it('rejects a payload without the file envelope', async () => {
    process.env.OPENSWARM_AUTH_PROFILES = JSON.stringify({ 'openrouter:default': VALID_PROFILE });
    await expect(freshStore()).rejects.toThrow(/envelope/);
  });
});

describe('gpt adapter OPENAI_API_KEY (INT-3101)', () => {
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it('reports available with only the env key set', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    vi.resetModules();
    const { GptCliAdapter } = await import('../adapters/gpt.js');
    await expect(new GptCliAdapter().isAvailable()).resolves.toBe(true);
  });

  it('an env key bypasses a broken auth store entirely', async () => {
    // run() must not construct AuthProfileStore on the key path: a corrupt
    // store file (or invalid OPENSWARM_AUTH_PROFILES) would throw in the
    // constructor and block a caller who authenticated by key. Setting an
    // invalid env payload makes any construction observable as a throw.
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENSWARM_AUTH_PROFILES = '{broken json';
    try {
      vi.resetModules();
      const { GptCliAdapter } = await import('../adapters/gpt.js');
      const result = await new GptCliAdapter().run({
        prompt: 'ping',
        // Aborted immediately: proves we got past auth to the network call.
        signal: AbortSignal.timeout(1),
      } as never);
      expect(result.stderr).not.toContain('Auth error');
      expect(result.stderr).not.toContain('OPENSWARM_AUTH_PROFILES');
    } finally {
      delete process.env.OPENSWARM_AUTH_PROFILES;
    }
  });
});
