import { describe, it, expect } from 'vitest';
import { enPrompts } from './en.js';
import { koPrompts } from './ko.js';

// ── 1. systemPrompt ────────────────────────────────────────────

describe('systemPrompt', () => {
  it('en: is a non-empty string', () => {
    expect(enPrompts.systemPrompt.length).toBeGreaterThan(0);
  });

  it('ko: is a non-empty string', () => {
    expect(koPrompts.systemPrompt.length).toBeGreaterThan(0);
  });

  it('en: contains destructive command rules', () => {
    expect(enPrompts.systemPrompt).toContain('rm -rf');
    expect(enPrompts.systemPrompt).toContain('git reset --hard');
  });

  it('ko: contains destructive command rules', () => {
    expect(koPrompts.systemPrompt).toContain('rm -rf');
    expect(koPrompts.systemPrompt).toContain('git reset --hard');
  });

  it('en: is compact (under 600 chars)', () => {
    expect(enPrompts.systemPrompt.length).toBeLessThan(600);
  });

  it('ko: is compact (under 600 chars)', () => {
    expect(koPrompts.systemPrompt.length).toBeLessThan(600);
  });
});

// ── 2. buildWorkerPrompt (en only — ko has same structure) ─────

describe('buildWorkerPrompt', () => {
  const base = { taskTitle: 'Fix login bug', taskDescription: 'Session expires too fast' };

  it('returns string containing task title and description', () => {
    const result = enPrompts.buildWorkerPrompt(base);
    expect(result).toContain('Fix login bug');
    expect(result).toContain('Session expires too fast');
  });

  it('contains output format JSON block', () => {
    const result = enPrompts.buildWorkerPrompt(base);
    expect(result).toContain('"success"');
    expect(result).toContain('"filesChanged"');
    expect(result).toContain('"confidencePercent"');
  });

  it('contains rules section', () => {
    const result = enPrompts.buildWorkerPrompt(base);
    expect(result).toContain('## Rules');
  });

  it('with previousFeedback: includes feedback section', () => {
    const result = enPrompts.buildWorkerPrompt({
      ...base,
      previousFeedback: 'Add error handling',
    });
    expect(result).toContain('Previous Feedback');
    expect(result).toContain('Add error handling');
  });

  it('without previousFeedback: no feedback section', () => {
    const result = enPrompts.buildWorkerPrompt(base);
    expect(result).not.toContain('Previous Feedback');
  });

  it('with context.impactAnalysis: includes Affected Modules section', () => {
    const result = enPrompts.buildWorkerPrompt({
      ...base,
      context: {
        impactAnalysis: {
          directModules: ['auth', 'session'],
          dependentModules: ['api'],
          testFiles: ['auth.test.ts'],
          estimatedScope: 'medium',
        },
      },
    });
    expect(result).toContain('Affected Modules');
    expect(result).toContain('auth');
    expect(result).toContain('session');
  });

  it('with context.registryBriefs (including entities): includes file map with entity signatures', () => {
    const result = enPrompts.buildWorkerPrompt({
      ...base,
      context: {
        registryBriefs: [
          {
            filePath: 'src/auth.ts',
            summary: '3 entities, 1 deprecated',
            highlights: ['login'],
            entities: [
              {
                kind: 'function',
                name: 'login',
                signature: '(user: string, pass: string) => Promise<Token>',
                status: 'active',
                hasTests: false,
              },
            ],
          },
        ],
      },
    });
    expect(result).toContain('File Map');
    expect(result).toContain('src/auth.ts');
    expect(result).toContain('function login');
    expect(result).toContain('(user: string, pass: string) => Promise<Token>');
    expect(result).toContain('[no test]');
  });

  it('with context.draftAnalysis: includes Pre-Analysis section', () => {
    const result = enPrompts.buildWorkerPrompt({
      ...base,
      context: {
        draftAnalysis: {
          taskType: 'bugfix',
          intentSummary: 'Fix session timeout',
          relevantFiles: ['src/session.ts'],
          suggestedApproach: 'Increase TTL',
        },
      },
    });
    expect(result).toContain('Pre-Analysis');
    expect(result).toContain('bugfix');
    expect(result).toContain('Increase TTL');
  });

  it('without context: no Code Context section', () => {
    const result = enPrompts.buildWorkerPrompt(base);
    expect(result).not.toContain('Code Context');
  });

  it('context section says "no need to Read these files"', () => {
    const result = enPrompts.buildWorkerPrompt({
      ...base,
      context: {
        registryBriefs: [
          { filePath: 'src/x.ts', summary: '1 entity', highlights: [] },
        ],
      },
    });
    expect(result).toContain('no need to Read these files');
  });
});

// ── 3. buildReviewerPrompt ─────────────────────────────────────

describe('buildReviewerPrompt', () => {
  const opts = {
    taskTitle: 'Add caching',
    taskDescription: 'Cache API responses',
    workerReport: 'Added Redis cache layer',
  };

  it('contains task title, description, and worker report', () => {
    const result = enPrompts.buildReviewerPrompt(opts);
    expect(result).toContain('Add caching');
    expect(result).toContain('Cache API responses');
    expect(result).toContain('Added Redis cache layer');
  });

  it('contains decision options (approve/revise/reject)', () => {
    const result = enPrompts.buildReviewerPrompt(opts);
    expect(result).toContain('approve');
    expect(result).toContain('revise');
    expect(result).toContain('reject');
  });

  it('contains JSON output format', () => {
    const result = enPrompts.buildReviewerPrompt(opts);
    expect(result).toContain('"decision"');
    expect(result).toContain('"feedback"');
    expect(result).toContain('"issues"');
    expect(result).toContain('"suggestions"');
  });
});

// ── 4. buildRevisionPromptFromReview ───────────────────────────

describe('buildRevisionPromptFromReview', () => {
  it('includes decision, feedback, issues list, suggestions list', () => {
    const result = enPrompts.buildRevisionPromptFromReview({
      decision: 'revise',
      feedback: 'Needs error handling',
      issues: ['No try-catch around API call', 'Missing null check'],
      suggestions: ['Use Result type', 'Add logging'],
    });
    expect(result).toContain('REVISE');
    expect(result).toContain('Needs error handling');
    expect(result).toContain('1. No try-catch around API call');
    expect(result).toContain('2. Missing null check');
    expect(result).toContain('1. Use Result type');
    expect(result).toContain('2. Add logging');
  });

  it('empty issues: no issues section', () => {
    const result = enPrompts.buildRevisionPromptFromReview({
      decision: 'revise',
      feedback: 'Minor style issues',
      issues: [],
      suggestions: ['Run prettier'],
    });
    expect(result).not.toContain('Issues to resolve');
    expect(result).toContain('Suggestions');
    expect(result).toContain('Run prettier');
  });
});

// ── 5. buildPlannerPrompt ──────────────────────────────────────

describe('buildPlannerPrompt', () => {
  const base = {
    taskTitle: 'Refactor auth module',
    taskDescription: 'Split into smaller files',
    projectName: 'OpenSwarm',
    targetMinutes: 30,
  };

  it('contains task title, project name, and target minutes', () => {
    const result = enPrompts.buildPlannerPrompt(base);
    expect(result).toContain('Refactor auth module');
    expect(result).toContain('OpenSwarm');
    expect(result).toContain('30');
  });

  it('with draftAnalysis: includes pre-analysis section', () => {
    const result = enPrompts.buildPlannerPrompt({
      ...base,
      draftAnalysis: {
        taskType: 'refactor',
        intentSummary: 'Improve modularity',
        relevantFiles: ['src/auth.ts'],
        suggestedApproach: 'Extract helpers',
      },
    });
    expect(result).toContain('Pre-Analysis');
    expect(result).toContain('refactor');
    expect(result).toContain('Extract helpers');
  });

  it('with impactAnalysis: includes KG section', () => {
    const result = enPrompts.buildPlannerPrompt({
      ...base,
      impactAnalysis: {
        directModules: ['auth'],
        dependentModules: ['api'],
        testFiles: ['auth.test.ts'],
        estimatedScope: 'large',
      },
    });
    expect(result).toContain('Knowledge Graph');
    expect(result).toContain('auth');
    expect(result).toContain('large');
  });
});
