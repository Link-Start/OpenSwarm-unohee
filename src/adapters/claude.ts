// ============================================
// OpenSwarm - Claude CLI Adapter ("claude -p" proxy mode)
// Wraps the Claude Code headless CLI (`claude -p`) as a model backend, so OpenSwarm can route
// worker/reviewer/chat through a logged-in Claude Code subscription. Restored after the v0.6.0
// claude-p removal (INT-1420/1574) as an OPT-IN provider — a fallback when codex hits its usage
// limit or OpenRouter is unavailable.
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
import { parseWorkerResult, parseReviewerResult } from './resultParsing.js';
import { parseCliStreamChunk, extractResultFromStreamJson } from '../agents/cliStreamParser.js';
import { extractCostFromStreamJson, formatCost } from '../support/costTracker.js';

const execFileAsync = promisify(execFile);

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class ClaudeCliAdapter implements CliAdapter {
  readonly name = 'claude';

  readonly capabilities: AdapterCapabilities = {
    supportsStreaming: true,
    supportsJsonOutput: true,
    supportsModelSelection: true,
    managedGit: false,
    supportedSkills: [],
  };

  /** `claude` must be on PATH. An interactive shell may alias it to a function; the real binary is
   *  what a non-shell `which`/spawn resolves — which is exactly what buildCommand runs. */
  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('which', ['claude']);
      return true;
    } catch {
      return false;
    }
  }

  buildCommand(options: CliRunOptions): { command: string; args: string[] } {
    // spawnCli writes the prompt to a temp file (options.prompt = path). Pipe it via stdin to avoid
    // arg-length/quoting limits. `--permission-mode bypassPermissions` lets the agent edit/run in the
    // cwd without interactive prompts (headless). stream-json + --verbose gives parseable events.
    const promptFile = options.prompt;
    const modelFlag = options.model ? ` --model ${shellEscape(options.model)}` : '';
    const maxTurnsFlag = options.maxTurns ? ` --max-turns ${options.maxTurns}` : '';
    const systemFlag = options.systemPrompt
      ? ` --append-system-prompt ${shellEscape(options.systemPrompt)}`
      : '';
    const cmd =
      `cat ${shellEscape(promptFile)} | claude -p --output-format stream-json --verbose ` +
      `--permission-mode bypassPermissions${modelFlag}${maxTurnsFlag}${systemFlag}`;
    return { command: cmd, args: [] };
  }

  parseStreamingChunk(chunk: string, onLog: (line: string) => void, buffer = ''): string {
    return parseCliStreamChunk(chunk, onLog, buffer);
  }

  parseWorkerOutput(raw: CliRunResult): WorkerResult {
    const cost = extractCostFromStreamJson(raw.stdout);
    if (cost) console.log(`[Worker] Cost: ${formatCost(cost)}`);
    // claude -p stream-json wraps the final answer in a `result` event; fall back to raw stdout.
    const resultText = extractResultFromStreamJson(raw.stdout) ?? raw.stdout;
    return parseWorkerResult(resultText);
  }

  parseReviewerOutput(raw: CliRunResult): ReviewResult {
    const cost = extractCostFromStreamJson(raw.stdout);
    if (cost) console.log(`[Reviewer] Cost: ${formatCost(cost)}`);
    const resultText = extractResultFromStreamJson(raw.stdout) ?? raw.stdout;
    return parseReviewerResult(resultText);
  }
}
