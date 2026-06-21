import { describe, expect, it, vi } from 'vitest';
import { buildGroomingPrompt, parseGroomingVerdicts, groomBacklog } from './backlogGrooming.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';

const mk = (id: string, title: string, description?: string): TaskItem => ({
  id, issueIdentifier: id, source: 'linear', title, description, priority: 3, createdAt: 0,
});

describe('backlogGrooming', () => {
  describe('buildGroomingPrompt', () => {
    it('includes every issue and the repo summary', () => {
      const p = buildGroomingPrompt([mk('INT-1', 'Add auth'), mk('INT-2', 'Fix bug', 'in parser')], 'Repo X — 10 modules.');
      expect(p).toContain('INT-1: Add auth');
      expect(p).toContain('INT-2: Fix bug — in parser');
      expect(p).toContain('Repo X — 10 modules.');
      expect(p).toContain('likely-done');
    });
  });

  describe('parseGroomingVerdicts', () => {
    it('parses a JSON array of verdicts', () => {
      const v = parseGroomingVerdicts('here: [{"id":"INT-1","classification":"likely-done","evidence":"auth.ts exists"}]');
      expect(v).toEqual([{ issueIdentifier: 'INT-1', classification: 'likely-done', evidence: 'auth.ts exists' }]);
    });

    it('defaults an unknown classification to active and skips id-less entries', () => {
      const v = parseGroomingVerdicts('[{"id":"INT-1","classification":"weird"},{"classification":"active"}]');
      expect(v).toEqual([{ issueIdentifier: 'INT-1', classification: 'active', evidence: '' }]);
    });

    it('returns [] for non-JSON / malformed output', () => {
      expect(parseGroomingVerdicts('no json here')).toEqual([]);
      expect(parseGroomingVerdicts('[not json')).toEqual([]);
    });
  });

  describe('groomBacklog', () => {
    it('classifies issues via the injected fn', async () => {
      const classify = vi.fn(async () =>
        '[{"id":"INT-1","classification":"likely-done","evidence":"done"},{"id":"INT-2","classification":"active","evidence":"todo"}]');
      const verdicts = await groomBacklog([mk('INT-1', 'a'), mk('INT-2', 'b')], 'repo', classify);
      expect(classify).toHaveBeenCalledOnce();
      expect(verdicts.map((v) => v.classification)).toEqual(['likely-done', 'active']);
    });

    it('short-circuits with no issues (no model call)', async () => {
      const classify = vi.fn(async () => '[]');
      expect(await groomBacklog([], 'repo', classify)).toEqual([]);
      expect(classify).not.toHaveBeenCalled();
    });
  });
});
