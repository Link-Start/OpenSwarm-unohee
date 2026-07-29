// ============================================
// OpenSwarm - GPT CLI Adapter
// Calls OpenAI Chat Completions API via OAuth token
// Agentic tool loop 지원 (read/write/edit/search/bash)
// ============================================

import type {
  CliAdapter,
  CliRunOptions,
  CliRunResult,
  AdapterCapabilities,
  WorkerResult,
  ReviewResult,
} from './types.js';
import { AuthProfileStore, ensureValidToken } from '../auth/index.js';
import { runAgenticLoop, loopResultToCliResult, type ChatMessage, type AgenticLoopOptions } from './agenticLoop.js';
import { resolveMcpTools } from '../mcp/mcpClient.js';
import { parseWorkerResult, parseReviewerResult } from './resultParsing.js';
import { consumeChatCompletionsStream } from './chatStream.js';
import type { ToolDefinition } from './tools.js';
import { RateLimitError } from './rateLimitError.js';
import { resolveLimitResponse, type ThrottleState } from './throttleRetry.js';
import { isInfraError } from './errorClassification.js';

const OPENAI_API_BASE = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o';
const PROFILE_KEY = 'openai-gpt:default';

export class GptCliAdapter implements CliAdapter {
  readonly name = 'gpt';

  readonly capabilities: AdapterCapabilities = {
    supportsStreaming: false,
    supportsJsonOutput: true,
    supportsModelSelection: true,
    managedGit: false,
    supportedSkills: [],
  };

  async isAvailable(): Promise<boolean> {
    if (process.env.OPENAI_API_KEY?.trim()) return true;
    try {
      const store = new AuthProfileStore();
      const profile = store.getProfile(PROFILE_KEY);
      return profile !== null;
    } catch {
      return false;
    }
  }

  buildCommand(_options: CliRunOptions): { command: string; args: string[] } {
    // GPT 어댑터는 run()을 사용하므로 이 메서드는 호출되지 않음
    return { command: 'echo', args: ['"GPT adapter uses run() — not shell spawn"'] };
  }

  async getDefaultModel(): Promise<string> {
    return DEFAULT_MODEL;
  }

  async run(options: CliRunOptions): Promise<CliRunResult> {
    const startTime = Date.now();

    // Acquire a bearer: OPENAI_API_KEY takes precedence (headless CI — the
    // endpoint is standard api.openai.com, so a plain API key works and needs
    // no refresh flow); otherwise the ChatGPT OAuth profile. The store is only
    // constructed on the OAuth path: its constructor throws on a corrupt file
    // or invalid OPENSWARM_AUTH_PROFILES, which must not block a caller who
    // authenticated by key. (INT-3101)
    const envKey = process.env.OPENAI_API_KEY?.trim();
    let store: AuthProfileStore | null = null;
    let accessToken: string;
    if (envKey) {
      accessToken = envKey;
    } else {
      try {
        store = new AuthProfileStore();
        accessToken = await ensureValidToken(store, PROFILE_KEY);
      } catch (err) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: `Auth error: ${err instanceof Error ? err.message : String(err)} (or set OPENAI_API_KEY)`,
          durationMs: Date.now() - startTime,
        };
      }
    }

    const model = options.model ?? await this.getDefaultModel();

    // 2. 에이전틱 루프로 실행 (도구 사용 가능)
    const callApi = this.createApiCaller(accessToken, store, model, options.onToken, options.signal);

    // MCP tools: caller-provided, else self-source from the registry
    // (mcp.json + config.mcp.servers) so standalone chat/exec and the worker
    // path all get MCP without each caller threading them. (INT-1951)
    const mcpTools = await resolveMcpTools(options.mcpTools);

    const loopOptions: AgenticLoopOptions = {
      systemPrompt: options.systemPrompt,
      prompt: options.prompt,
      cwd: options.cwd ?? process.cwd(),
      model,
      callApi,
      maxTurns: options.maxTurns ?? 15,
      timeoutMs: options.timeoutMs ?? 300000,
      onLog: options.onLog,
      enableTools: options.enableTools ?? true,
      nudgeMaxOnNoEdit: options.nudgeMaxOnNoEdit,
      protectedFiles: options.protectedFiles,
      bashTimeoutMs: options.bashTimeoutMs,
      webTools: options.webTools,
      memoryTools: options.memoryTools,
      readOnly: options.readOnly,
      mcpTools,
      signal: options.signal,
      editFormat: options.editFormat,
    };

    try {
      const result = await runAgenticLoop(loopOptions);
      if (options.onLog) {
        options.onLog(`[GPT] ${result.apiCallCount} API calls, ${result.toolCallCount} tool uses, ${result.totalTokens} tokens`);
      }
      return loopResultToCliResult(result);
    } catch (err) {
      // Rate-limit AND infra/capacity errors must propagate so the pipeline
      // classifies them (pause / infra_error backoff) instead of burying them in a
      // fake failed CliRunResult that the worker reads as an empty success → STUCK. (INT-1906, INT-2520)
      if (err instanceof RateLimitError) throw err;
      if (isInfraError(err)) throw err;
      return {
        exitCode: 1,
        stdout: '',
        stderr: `GPT agentic loop failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * OpenAI API 호출 함수 생성 (에이전틱 루프에 주입)
   * 401 시 토큰 갱신 + 1회 재시도 포함
   */
  private createApiCaller(
    initialToken: string,
    /** Null when the bearer is a plain API key — there is no profile to refresh on 401. (INT-3101) */
    store: AuthProfileStore | null,
    model: string,
    onToken?: (delta: string) => void,
    signal?: AbortSignal,
  ) {
    let token = initialToken;
    // An env API key has no refresh flow; a 401 on it must surface as the auth
    // error it is instead of failing on a missing OAuth profile.
    let retried = store === null;

    return async (messages: ChatMessage[], tools: ToolDefinition[]) => {
      // Per-API-call throttle budget (INT-2907).
      const throttle: ThrottleState = { attempts: 0 };
      const body: Record<string, unknown> = {
        model,
        messages,
        temperature: 0.2,
        max_tokens: 16384,
        stream: true,
        stream_options: { include_usage: true },
      };
      if (tools.length > 0) {
        body.tools = tools;
      }

      const doCall = async (accessToken: string) => {
        const res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal,
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => '');

          // 401 → refresh the OAuth token and retry once. `retried` starts true
          // on the API-key path, so `store` is always present here.
          if (res.status === 401 && !retried && store) {
            retried = true;
            token = await refreshExpiredProfileForRetry(store);
            return doCall(token);
          }

          // A spent quota (429 insufficient_quota) → TYPED RateLimitError at the
          // source so the scheduler pauses instead of the loop swallowing it into
          // a fake empty success (INT-2520). A 429 rate_limit_exceeded is only
          // OpenAI pacing us (RPM/TPM): wait it out and retry rather than
          // reporting a usage limit that isn't there. (INT-2907)
          if (await resolveLimitResponse('openai', res.status, res.headers, errText, throttle, { signal }) === 'retry') {
            return doCall(accessToken);
          }

          throw new Error(`OpenAI API error (${res.status}): ${errText.slice(0, 500)}`);
        }

        return consumeChatCompletionsStream(res, onToken);
      };

      return doCall(token);
    };
  }

  parseWorkerOutput(raw: CliRunResult): WorkerResult {
    return parseWorkerResult(raw.stdout);
  }

  parseReviewerOutput(raw: CliRunResult): ReviewResult {
    return parseReviewerResult(raw.stdout);
  }

}

// Streamed chat/completions responses are parsed by consumeChatCompletionsStream.

export async function refreshExpiredProfileForRetry(store: AuthProfileStore): Promise<string> {
  const profile = store.getProfile(PROFILE_KEY);
  if (!profile) {
    throw new Error('No auth profile found');
  }
  // 강제 갱신 (expires를 0으로 설정)
  store.setProfile(PROFILE_KEY, { ...profile, expires: 0 });
  return ensureValidToken(store, PROFILE_KEY);
}

// Worker/Reviewer output parsing lives in ./resultParsing.ts (shared with the
// local, openrouter, and codex adapters — INT-1441).
