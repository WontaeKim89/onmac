import type { Message, ToolSpec } from "../types.ts";

export type ToolCallHandler = (name: string, args: Record<string, unknown>) => Promise<string>;

/**
 * LLM 백엔드 인터페이스.
 *
 * 루프를 백엔드 안에 두는 이유:
 *   node-llama-cpp 는 함수 호출 루프를 라이브러리가 직접 돌린다 (session.prompt 내부).
 *   MLX 사이드카는 우리가 돌려야 한다.
 * 두 방식을 하나로 억지로 맞추면 한쪽이 뒤틀린다. 대신 onToolCall 을 주입받게 해서
 * **정책 게이트와 트랜잭션은 양쪽이 반드시 공유**하도록 만든다.
 */
export interface LlmBackend {
  readonly name: string;
  complete(
    systemPrompt: string,
    history: Message[],
    tools: ToolSpec[],
    onToolCall: ToolCallHandler,
  ): Promise<string>;
  close(): Promise<void>;
}
