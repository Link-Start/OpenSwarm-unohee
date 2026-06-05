// ============================================
// OpenSwarm - Agentic Tool Loop
// Created: 2026-04-11
// Purpose: GPT/Local 어댑터에 Claude CLI와 동등한 도구 사용 능력을 부여하는
//          범용 에이전틱 루프 엔진.
//          OpenAI function calling 포맷 기반.
// ============================================

import { TOOL_DEFINITIONS, executeToolCalls, type ToolCall, type ToolResult, type ToolDefinition } from './tools.js';
import type { CliRunResult } from './types.js';

// ============ 타입 ============

/** OpenAI Chat Completions API 메시지 포맷 */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ApiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ApiToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: ApiToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** 에이전틱 루프 설정 */
export interface AgenticLoopOptions {
  /** 시스템 프롬프트 */
  systemPrompt?: string;
  /** 사용자 프롬프트 (작업 지시) */
  prompt: string;
  /** 프로젝트 작업 디렉토리 (도구 실행 cwd) */
  cwd: string;
  /** 모델명 */
  model: string;
  /** API 호출 함수 (어댑터별로 주입) */
  callApi: (messages: ChatMessage[], tools: ToolDefinition[]) => Promise<ChatCompletionResponse>;
  /** 최대 도구 사용 턴 수 (기본: 15) */
  maxTurns?: number;
  /** 전체 타임아웃 (ms, 기본: 300000) */
  timeoutMs?: number;
  /** 실시간 로그 콜백 */
  onLog?: (line: string) => void;
  /** 도구 사용 허용 여부 (기본: true) */
  enableTools?: boolean;
}

/** 루프 실행 결과 */
export interface AgenticLoopResult {
  /** 최종 텍스트 응답 */
  text: string;
  /** 사용한 도구 호출 횟수 */
  toolCallCount: number;
  /** 총 API 호출 횟수 */
  apiCallCount: number;
  /** 총 토큰 사용량 (추적 가능한 경우) */
  totalTokens: number;
  /** 소요 시간 (ms) */
  durationMs: number;
}

// ============ 에이전틱 루프 ============

/**
 * 에이전틱 도구 루프 실행
 *
 * 흐름:
 * 1. 프롬프트로 API 호출 (도구 정의 포함)
 * 2. 응답에 tool_calls가 있으면 → 도구 실행 → 결과를 메시지에 추가 → 2로
 * 3. 응답에 tool_calls가 없으면 (finish_reason = 'stop') → 최종 텍스트 반환
 */
export async function runAgenticLoop(options: AgenticLoopOptions): Promise<AgenticLoopResult> {
  const {
    systemPrompt,
    prompt,
    cwd,
    callApi,
    maxTurns = 15,
    timeoutMs = 300000,
    onLog,
    enableTools = true,
  } = options;

  const startTime = Date.now();
  const deadline = startTime + timeoutMs;

  // 메시지 히스토리 구성
  const messages: ChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  const tools = enableTools ? TOOL_DEFINITIONS : [];
  let toolCallCount = 0;
  let apiCallCount = 0;
  let totalTokens = 0;
  let finalText = '';

  for (let turn = 0; turn < maxTurns + 1; turn++) {
    // 타임아웃 체크
    if (Date.now() > deadline) {
      onLog?.(`⏰ Agentic loop timeout after ${turn} turns`);
      break;
    }

    // 매 턴 히스토리 압축 — 이전 턴의 tool call/result를 1줄 요약으로 교체
    if (turn >= 2) {
      compactPriorTurns(messages);
    }

    // API 호출
    apiCallCount++;
    onLog?.(`▸ API call #${apiCallCount}${turn > 0 ? ` (tool turn ${turn})` : ''}`);

    let response: ChatCompletionResponse;
    try {
      response = await callApi(messages, tools);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onLog?.(`✖ API error: ${msg}`);
      finalText = `API error: ${msg}`;
      break;
    }

    if (response.usage) {
      totalTokens += response.usage.prompt_tokens + response.usage.completion_tokens;
    }

    const choice = response.choices?.[0];
    if (!choice) {
      onLog?.('✖ Empty response from API');
      finalText = 'Empty API response';
      break;
    }

    const assistantMsg = choice.message;

    // 도구 호출이 없으면 최종 응답
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      finalText = assistantMsg.content ?? '';
      break;
    }

    // 어시스턴트 메시지를 히스토리에 추가 (tool_calls 포함)
    messages.push({
      role: 'assistant',
      content: assistantMsg.content,
      tool_calls: assistantMsg.tool_calls,
    });

    // 도구 실행
    const toolCalls: ToolCall[] = assistantMsg.tool_calls.map(tc => ({
      id: tc.id,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));

    for (const tc of toolCalls) {
      try {
        const args = JSON.parse(tc.function.arguments);
        const argSummary = summarizeToolArgs(tc.function.name, args);
        onLog?.(`  🔧 ${tc.function.name}${argSummary ? ': ' + argSummary : ''}`);
      } catch {
        onLog?.(`  🔧 ${tc.function.name}`);
      }
    }

    const results: ToolResult[] = await executeToolCalls(toolCalls, cwd);
    toolCallCount += toolCalls.length;

    // 도구 결과를 메시지에 추가
    for (const result of results) {
      messages.push({
        role: 'tool',
        tool_call_id: result.tool_call_id,
        content: result.content,
      });
      if (result.is_error) {
        onLog?.(`  ✖ ${result.content.slice(0, 100)}`);
      }
    }
  }

  return {
    text: finalText,
    toolCallCount,
    apiCallCount,
    totalTokens,
    durationMs: Date.now() - startTime,
  };
}

/**
 * AgenticLoopResult → CliRunResult 변환
 */
export function loopResultToCliResult(result: AgenticLoopResult): CliRunResult {
  return {
    exitCode: 0,
    stdout: result.text,
    stderr: '',
    durationMs: result.durationMs,
  };
}

// ============ 히스토리 압축 ============

/**
 * 최근 1턴(assistant + tool results)만 원본 유지.
 * 그 이전 턴의 assistant+tool 쌍을 1줄 요약 assistant 메시지로 교체.
 *
 * 구조 변환:
 *   [system, user, asst(tool_calls), tool, tool, asst(tool_calls), tool, ...]
 *   → [system, user, asst("Prior: read_file→ok, edit→ok"), asst(latest_tool_calls), tool, ...]
 *
 * OpenAI API 제약: tool 메시지는 직전 assistant의 tool_call_id와 대응해야 함.
 * 따라서 오래된 tool 메시지는 삭제하고, 해당 assistant도 일반 텍스트로 교체.
 */
function compactPriorTurns(messages: ChatMessage[]): void {
  const headerCount = messages[0]?.role === 'system' ? 2 : 1;

  // 마지막 assistant+tool 블록의 시작 인덱스 찾기
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= headerCount; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx <= headerCount) return; // 압축할 이전 턴이 없음

  // headerCount ~ lastAssistantIdx 사이의 모든 assistant+tool 쌍을 요약
  const summaryParts: string[] = [];
  const toRemove: number[] = [];

  for (let i = headerCount; i < lastAssistantIdx; i++) {
    const msg = messages[i];

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      // tool call 요약: "read_file(src/foo.ts), edit_file(src/foo.ts)"
      const callSummaries = msg.tool_calls.map(tc => {
        try {
          const args = JSON.parse(tc.function.arguments);
          const key = args.path || args.pattern || args.command;
          const short = typeof key === 'string' ? key.slice(0, 50) : '';
          return `${tc.function.name}(${short})`;
        } catch {
          return tc.function.name;
        }
      });
      summaryParts.push(callSummaries.join(', '));
      toRemove.push(i);
    } else if (msg.role === 'tool') {
      // tool result → 성공/실패만 기록
      const ok = !msg.content.startsWith('BLOCKED') && !msg.content.startsWith('Tool error');
      const firstLine = msg.content.split('\n')[0].slice(0, 60);
      summaryParts.push(ok ? `→ok` : `→err: ${firstLine}`);
      toRemove.push(i);
    } else if (msg.role === 'assistant' && !msg.tool_calls) {
      // 일반 assistant 메시지 — 첫 줄만 유지
      const short = (msg.content ?? '').split('\n')[0].slice(0, 80);
      if (short) summaryParts.push(`note: ${short}`);
      toRemove.push(i);
    }
  }

  if (toRemove.length === 0) return;

  // 요약 메시지 생성
  const summaryText = `[Prior turns compacted] ${summaryParts.join(' | ')}`;

  // 역순으로 제거 (인덱스 안정성)
  for (let i = toRemove.length - 1; i >= 0; i--) {
    messages.splice(toRemove[i], 1);
  }

  // header 직후에 요약 삽입
  messages.splice(headerCount, 0, {
    role: 'assistant',
    content: summaryText,
  });
}

// ============ 헬퍼 ============

function summarizeToolArgs(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'read_file':
      return String(args.path ?? '');
    case 'write_file':
      return String(args.path ?? '');
    case 'edit_file':
      return String(args.path ?? '');
    case 'search_files':
      return `"${args.pattern}" in ${args.path}`;
    case 'bash':
      return String(args.command ?? '').slice(0, 80);
    default:
      return '';
  }
}
