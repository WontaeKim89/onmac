import type { LlmBackend, ToolCallHandler } from "./backend.ts";
import type { Message, ToolSpec } from "../types.ts";

/**
 * node-llama-cpp 백엔드 — 기본값.
 *
 * 파이썬 없이 `npm i` 만으로 동작하는 경로다. 오픈소스 사용자의 첫 실행은 반드시 여기를 탄다.
 * node-llama-cpp 는 함수 호출 루프를 라이브러리가 직접 돌리므로, 우리는 각 함수의 handler 안에서
 * onToolCall(= 정책 게이트 + 트랜잭션 기록)을 부른다. 게이트를 우회할 경로가 생기지 않는다.
 *
 * 의존성은 optional 이라 설치되어 있지 않으면 명확한 안내와 함께 실패한다.
 */
export class LlamaCppBackend implements LlmBackend {
  readonly name = "llamacpp";
  private session?: unknown;
  private ctx?: { dispose: () => Promise<void> };
  private lib?: typeof import("node-llama-cpp");
  private readonly opts: { modelPath: string; mmprojPath?: string; maxKvSize: number; maxTurns: number };

  constructor(opts: { modelPath: string; mmprojPath?: string; maxKvSize: number; maxTurns: number }) {
    this.opts = opts;
  }

  private async ensureStarted(): Promise<typeof import("node-llama-cpp")> {
    if (this.lib && this.session) return this.lib;
    try {
      this.lib = await import("node-llama-cpp");
    } catch {
      throw new Error(
        "node-llama-cpp 가 설치되어 있지 않습니다.\n" +
          "  npm i node-llama-cpp\n" +
          "또는 onmac.toml 에서 backend = \"mlx\" 로 전환하십시오.",
      );
    }
    const { getLlama, LlamaChatSession } = this.lib;
    const llama = await getLlama();
    const model = await llama.loadModel({ modelPath: this.opts.modelPath });
    const context = await model.createContext({ contextSize: this.opts.maxKvSize });
    this.ctx = context;
    this.session = new LlamaChatSession({ contextSequence: context.getSequence() });
    return this.lib;
  }

  async warmup(): Promise<void> {
    await this.ensureStarted();
  }

  async complete(
    systemPrompt: string,
    history: Message[],
    tools: ToolSpec[],
    onToolCall: ToolCallHandler,
    _onDelta?: (text: string) => void, // node-llama-cpp 경로는 아직 비스트리밍
  ): Promise<string> {
    const lib = await this.ensureStarted();
    const { defineChatSessionFunction } = lib;

    const functions = Object.fromEntries(
      tools.map((t) => [
        t.name,
        defineChatSessionFunction({
          description: t.description,
          // 스키마를 런타임에 조립하므로 라이브러리의 파라미터 타입 추론을 쓸 수 없다.
          // 인자 검증은 각 툴의 run() 안에서 직접 한다.
          params: t.parameters as never,
          // 라이브러리가 이 핸들러를 부른다. 정책 게이트는 여기서 걸린다.
          handler: (async (args: unknown) =>
            onToolCall(t.name, (args ?? {}) as Record<string, unknown>)) as never,
        }),
      ]),
    );

    const session = this.session as {
      prompt: (
        text: string,
        opts: { functions: unknown; maxParallelFunctionCalls: number },
      ) => Promise<string>;
      setChatHistory?: (h: unknown) => void;
    };

    const userText = history.filter((m) => m.role === "user").at(-1)?.content ?? "";
    return session.prompt(`${systemPrompt}\n\n---\n\n${userText}`, {
      functions,
      maxParallelFunctionCalls: 1, // 승인 UI 가 한 번에 하나씩 물어야 사용자가 판단할 수 있다
    });
  }

  async close(): Promise<void> {
    await this.ctx?.dispose();
  }
}
