// ============================================
// OpenSwarm - Codex CLI Adapter
// Wraps `codex exec --json` for agent execution
// ============================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  CliAdapter,
  CliRunOptions,
  CliRunResult,
  AdapterCapabilities,
  WorkerResult,
  ReviewResult,
} from './types.js';
import { AuthProfileStore, ensureValidToken } from '../auth/index.js';
import { getCodexModelIds } from './codexModels.js';
import { parseWorkerResult, parseReviewerResult } from './resultParsing.js';

const execFileAsync = promisify(execFile);

// Codex shares the ChatGPT OAuth profile with the gpt adapter — the same token
// authorizes the Codex backend models endpoint.
const CODEX_PROFILE_KEY = 'openai-gpt:default';

export class CodexCliAdapter implements CliAdapter {
  readonly name = 'codex';

  readonly capabilities: AdapterCapabilities = {
    supportsStreaming: true,
    supportsJsonOutput: true,
    supportsModelSelection: true,
    managedGit: true,
    supportedSkills: [],
  };

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('which', ['codex']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List the Codex models this account can use. Tries the live Codex OAuth
   * backend (when authenticated via `openswarm auth login --provider gpt`),
   * falling back to the local ~/.codex sources and a curated default list.
   */
  async listModels(): Promise<string[]> {
    let accessToken: string | undefined;
    try {
      const store = new AuthProfileStore();
      if (store.getProfile(CODEX_PROFILE_KEY)) {
        accessToken = await ensureValidToken(store, CODEX_PROFILE_KEY);
      }
    } catch {
      // No/expired auth — fall back to offline sources inside getCodexModelIds.
    }
    return getCodexModelIds(accessToken);
  }

  buildCommand(options: CliRunOptions): { command: string; args: string[] } {
    const promptFile = options.prompt;
    const resolvedModel = options.model ? coerceCodexModel(options.model) : undefined;
    const modelFlag = resolvedModel ? ` -m ${shellEscape(resolvedModel)}` : '';
    // Reasoning effort → codex config override (`-c model_reasoning_effort=...`). The CLI has no
    // dedicated effort flag, so we set it via the same `-c key=value` mechanism it uses for config.
    const effortFlag = options.reasoningEffort
      ? ` -c ${shellEscape(`model_reasoning_effort=${options.reasoningEffort}`)}`
      : '';
    const cmd = `cat ${shellEscape(promptFile)} | codex exec --json --full-auto --skip-git-repo-check${modelFlag}${effortFlag}`;
    return { command: cmd, args: [] };
  }

  parseStreamingChunk(
    chunk: string,
    onLog: (line: string) => void,
    buffer: string = '',
  ): string {
    const combined = buffer + chunk;
    const lines = combined.split('\n');
    const remainder = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      emitCodexStreamEvent(trimmed, onLog);
    }

    return remainder;
  }

  parseWorkerOutput(raw: CliRunResult): WorkerResult {
    return parseWorkerResult(extractCodexMessageText(raw.stdout));
  }

  parseReviewerOutput(raw: CliRunResult): ReviewResult {
    return parseReviewerResult(extractCodexMessageText(raw.stdout));
  }
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Codex (ChatGPT account mode) only accepts OpenAI-family models. When a
 * pipeline role was configured with a Claude model and the operator later
 * switched the global adapter to `codex`, the CLI returns:
 *   400 invalid_request_error: The 'claude-...' model is not supported when
 *   using Codex with a ChatGPT account.
 *
 * Rather than letting the request fail, transparently substitute the Codex
 * default and log a warning so the operator can see what happened and either
 * fix their config or accept the substitution.
 */
const CODEX_DEFAULT_MODEL = 'gpt-5-codex';
const warnedAboutModel = new Set<string>();

export function coerceCodexModel(requested: string): string {
  if (!isClaudeModel(requested)) return requested;
  if (!warnedAboutModel.has(requested)) {
    warnedAboutModel.add(requested);
    console.warn(
      `[CodexAdapter] '${requested}' is a Claude model and is not accepted by codex with a ChatGPT account. ` +
        `Substituting '${CODEX_DEFAULT_MODEL}'. Set worker/reviewer model explicitly in config.yaml to silence this.`,
    );
  }
  return CODEX_DEFAULT_MODEL;
}

function isClaudeModel(name: string): boolean {
  return /^claude[-_]/i.test(name);
}

function extractCodexMessageText(output: string): string {
  let lastMessage = '';

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const event = JSON.parse(trimmed);
      if (
        event.type === 'item.completed' &&
        event.item?.type === 'agent_message' &&
        typeof event.item.text === 'string'
      ) {
        lastMessage = event.item.text;
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }

  return lastMessage || output;
}

function emitCodexStreamEvent(line: string, onLog: (line: string) => void): void {
  try {
    const event = JSON.parse(line);
    const eventType = typeof event.type === 'string' ? event.type : '';

    if (eventType === 'turn.started') {
      onLog('───');
      onLog('Codex turn started');
      return;
    }

    if (eventType === 'turn.completed') {
      onLog('Codex turn completed');
      return;
    }

    if (
      eventType === 'item.completed' &&
      event.item?.type === 'agent_message' &&
      typeof event.item.text === 'string'
    ) {
      emitCodexText(event.item.text, onLog);
      return;
    }

    if (eventType === 'item.completed' && event.item?.type === 'reasoning') {
      const summary = summarizeCodexReasoning(event.item);
      if (summary) onLog(`▸ ${summary}`);
      return;
    }

    if (eventType === 'error' && typeof event.message === 'string') {
      onLog(`ERROR: ${truncate(event.message, 300)}`);
    }
  } catch {
    // Ignore malformed or partial non-JSON lines.
  }
}

function emitCodexText(text: string, onLog: (line: string) => void): void {
  const lines = text.split('\n');
  let inCodeBlock = false;
  let prevWasEmpty = false;

  for (const raw of lines) {
    const trimmed = raw.trim();

    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      onLog(inCodeBlock ? '┌─ code ─' : '└────────');
      prevWasEmpty = false;
      continue;
    }

    if (!trimmed) {
      if (!prevWasEmpty) {
        onLog('');
        prevWasEmpty = true;
      }
      continue;
    }
    prevWasEmpty = false;

    if (inCodeBlock) {
      onLog('│ ' + truncate(raw, 300));
      continue;
    }

    const headerMatch = trimmed.match(/^(#{1,4})\s+(.+)/);
    if (headerMatch) {
      onLog('');
      onLog('■ ' + headerMatch[2]);
      continue;
    }

    if (/^[-*]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
      onLog('  ' + truncate(trimmed, 300));
      continue;
    }

    onLog(truncate(trimmed, 300));
  }
}

function summarizeCodexReasoning(item: Record<string, unknown>): string | null {
  if (typeof item.text === 'string' && item.text.trim()) {
    return truncate(item.text.trim(), 200);
  }

  if (typeof item.summary === 'string' && item.summary.trim()) {
    return truncate(item.summary.trim(), 200);
  }

  if (Array.isArray(item.summary)) {
    const text = item.summary
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object' && 'text' in entry && typeof entry.text === 'string') {
          return entry.text;
        }
        return '';
      })
      .filter(Boolean)
      .join(' ');

    return text ? truncate(text, 200) : null;
  }

  return null;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}
