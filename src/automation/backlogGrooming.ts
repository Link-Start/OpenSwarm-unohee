// ============================================
// OpenSwarm - Backlog Grooming Planner (INT-1609)
// A read-only grooming pass: classify each open issue against the CURRENT codebase as already-done
// vs still-active vs obsolete, in one bounded LLM call. PROPOSE-only — it returns verdicts; callers
// decide what to act on (per CLAUDE.md §1.5, Done-transitions can be automatic but cancels need
// approval). This is the manual backlog-reconstruction I do by hand, automated.
// ============================================
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { AdapterName } from '../adapters/index.js';
import { loadRepoSnapshot } from '../knowledge/index.js';
import { runChatCompletion } from '../support/chatBackend.js';

export type GroomingClassification = 'likely-done' | 'active' | 'obsolete';

export interface GroomingVerdict {
  issueIdentifier: string;
  classification: GroomingClassification;
  evidence: string;
}

const VALID_CLASSIFICATIONS = new Set<GroomingClassification>(['likely-done', 'active', 'obsolete']);

/** Compact, bounded repo summary (layer → sample modules) — repo-map style, NOT full files, so the
 *  grooming prompt stays small (the harness lesson: large context degrades model judgment). */
export function summarizeRepo(projectPath: string): string {
  const snap = loadRepoSnapshot(projectPath);
  if (!snap) return '(no repo snapshot available)';
  const layers = snap.project.layers
    .slice(0, 20)
    .map((l) => `- ${l.layer} (${l.count}): ${l.modules.slice(0, 8).join(', ')}`)
    .join('\n');
  return `Project ${snap.projectName} — ${snap.project.totalModules} modules.\nLayers:\n${layers}`;
}

export function buildGroomingPrompt(issues: TaskItem[], repoSummary: string): string {
  const list = issues
    .map((i) => {
      const id = i.issueIdentifier ?? i.id;
      const desc = i.description ? ` — ${i.description.replace(/\s+/g, ' ').slice(0, 160)}` : '';
      return `- ${id}: ${i.title}${desc}`;
    })
    .join('\n');
  return (
    'You are grooming a software backlog. Using the repo structure and the open issues, classify ' +
    'EACH issue as one of:\n' +
    '- "likely-done": the work appears already implemented in the codebase\n' +
    '- "active": still needed / not yet done\n' +
    '- "obsolete": no longer relevant\n\n' +
    'Respond with ONLY a JSON array:\n' +
    '[{"id":"<identifier>","classification":"likely-done|active|obsolete","evidence":"one short sentence"}]\n\n' +
    `## Repo\n${repoSummary}\n\n## Open issues\n${list}`
  );
}

export function parseGroomingVerdicts(response: string): GroomingVerdict[] {
  const json = response.match(/\[[\s\S]*\]/)?.[0];
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as unknown[];
    if (!Array.isArray(arr)) return [];
    const out: GroomingVerdict[] = [];
    for (const a of arr) {
      if (!a || typeof a !== 'object') continue;
      const r = a as Record<string, unknown>;
      const id = typeof r.id === 'string' ? r.id.trim() : '';
      if (!id) continue;
      const classification = typeof r.classification === 'string' && VALID_CLASSIFICATIONS.has(r.classification as GroomingClassification)
        ? (r.classification as GroomingClassification)
        : 'active';
      out.push({ issueIdentifier: id, classification, evidence: typeof r.evidence === 'string' ? r.evidence : '' });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Core grooming pass (INT-1609): classify each open issue against the current codebase. Pure
 * orchestration with an injected `classify` fn so it's testable without a live model. PROPOSE-only.
 */
export async function groomBacklog(
  issues: TaskItem[],
  repoSummary: string,
  classify: (prompt: string) => Promise<string>,
): Promise<GroomingVerdict[]> {
  if (issues.length === 0) return [];
  const response = await classify(buildGroomingPrompt(issues, repoSummary));
  return parseGroomingVerdicts(response);
}

/** Real grooming pass: load the repo snapshot + classify via the configured chat model (read-only). */
export async function runBacklogGrooming(
  issues: TaskItem[],
  projectPath: string,
  provider: AdapterName,
  model: string,
): Promise<GroomingVerdict[]> {
  const repoSummary = summarizeRepo(projectPath);
  return groomBacklog(issues, repoSummary, async (prompt) => {
    const r = await runChatCompletion({
      prompt, provider, model, cwd: projectPath, timeoutMs: 120_000, enableTools: false, maxTurns: 1,
    });
    return r.response;
  });
}
