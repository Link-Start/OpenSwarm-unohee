import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stop: vi.fn(),
  handlers: new Map<string, (payload: unknown) => void>(),
}));

vi.mock('../adapters/index.js', () => ({
  getAdapter: () => ({ isAvailable: async () => true }),
  getDefaultAdapterName: () => 'test',
  listAvailableAdapters: async () => ['test'],
}));

vi.mock('../agents/pairPipeline.js', () => ({
  PairPipeline: class {
    on(event: string, handler: (payload: unknown) => void): void {
      mocks.handlers.set(event, handler);
    }
    async run(): Promise<never> {
      mocks.handlers.get('stage:start')?.({ stage: 'worker' });
      throw new Error('pipeline boom');
    }
  },
}));

vi.mock('../cli/reviewProgress.js', () => ({
  startProgressHeartbeat: () => ({ stop: mocks.stop }),
}));

import { runCli } from './cliRunner.js';

describe('CLI runner failure cleanup', () => {
  const originalIsTTY = process.stdout.isTTY;
  const originalExitCode = process.exitCode;

  afterEach(() => {
    mocks.stop.mockReset();
    mocks.handlers.clear();
    vi.restoreAllMocks();
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
    process.exitCode = originalExitCode;
  });

  it('stops the live progress heartbeat before exiting on a pipeline error', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runCli({ task: 'test', projectPath: process.cwd() })).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });
});
