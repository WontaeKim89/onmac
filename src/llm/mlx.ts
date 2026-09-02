import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { LlmBackend, ToolCallHandler } from "./backend.ts";
import type { Message, ToolSpec } from "../types.ts";
import { status } from "../ui/status.ts";
import { dim } from "../ui/theme.ts";

interface SidecarStats {
  wall_s?: number;
  prompt_tokens?: number;
  gen_tokens?: number;
  cached_tokens?: number;
  gen_tps?: number;
}

interface SidecarReply {
  content?: string;
  tool_calls?: Array<{ name: string; args: Record<string, unknown> }>;
  stats?: SidecarStats;
  error?: string;
  ready?: boolean;
  apc?: boolean;
}

/**
 * MLX 백엔드 — 파이썬 사이드카를 자식 프로세스로 띄우고 JSON 한 줄씩 주고받는다.
 *
 * 프로세스를 나누는 이유는 MLX 가 파이썬 전용이기 때문이기도 하지만,
 * 모델 추론이 파일시스템 권한을 전혀 갖지 않는 별도 프로세스에 갇힌다는 부수 효과도 있다.
 */
export interface MlxOptions {
  modelPath: string;
  python: string;
  projectRoot: string;
  maxTurns: number;
  thinking: boolean;
  maxKvSize: number;
}

export class MlxBackend implements LlmBackend {
  readonly name = "mlx";
  private proc?: ChildProcessWithoutNullStreams;
  private rl?: Interface;
  private queue: Array<(r: SidecarReply) => void> = [];
  private readonly opts: MlxOptions;
  /** 마지막 호출의 실측치. /stats 로 보여준다. */
  lastStats?: SidecarStats;

  constructor(opts: MlxOptions) {
    this.opts = opts;
  }

  private async ensureStarted(): Promise<void> {
    if (this.proc) return;
    const script = join(this.opts.projectRoot, "python", "mlx_sidecar.py");
    this.proc = spawn(this.opts.python, [script, this.opts.modelPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    this.proc.stderr.on("data", (b: Buffer) => {
      const s = b.toString().trim();
      if (s) process.stderr.write(`[mlx] ${s}\n`);
    });
    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => {
      const resolve = this.queue.shift();
      if (resolve) resolve(JSON.parse(line) as SidecarReply);
    });

    // 사이드카가 죽으면 대기 중인 요청은 영원히 응답을 못 받는다.
    // 그 상태로 두면 프로세스가 아무 말 없이 멈춘 것처럼 보이므로 즉시 에러로 깨운다.
    const die = (why: string) => {
      this.proc = undefined as never;
      const pending = this.queue.splice(0);
      for (const r of pending) r({ error: why });
    };
    this.proc.on("exit", (code) => die(`사이드카가 종료되었습니다 (exit ${code}). 위 [mlx] 로그를 확인하십시오.`));
    this.proc.on("error", (e) => die(`사이드카 실행 실패: ${e.message}`));

    const ready = await this.send({ ping: true }, /* skipWrite */ true);
    if (!ready.ready) throw new Error(`MLX 사이드카 기동 실패: ${ready.error ?? "unknown"}`);
  }

  private send(payload: unknown, skipWrite = false): Promise<SidecarReply> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      if (!skipWrite) this.proc!.stdin.write(JSON.stringify(payload) + "\n");
    });
  }

  async warmup(): Promise<void> {
    await this.ensureStarted();
  }

  async complete(
    systemPrompt: string,
    history: Message[],
    tools: ToolSpec[],
    onToolCall: ToolCallHandler,
  ): Promise<string> {
    await this.ensureStarted();

    const msgs: Array<Record<string, unknown>> = [
      { role: "system", content: systemPrompt },
      ...history.map((m) => ({ role: m.role, content: m.content })),
    ];
    const toolSchemas = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    const images = history.flatMap((m) => m.images ?? []);

    for (let turn = 0; turn < this.opts.maxTurns; turn++) {
      status.phase(turn === 0 ? "생각하는 중" : `생각하는 중 ${dim(`(${turn + 1}번째 단계)`)}`);
      const reply = await this.send({
        messages: msgs,
        tools: toolSchemas,
        images: turn === 0 ? images : [],
        max_tokens: 2048,
        thinking: this.opts.thinking,
        max_kv_size: this.opts.maxKvSize,
      });
      if (reply.stats) this.lastStats = reply.stats;
      if (reply.error) throw new Error(`MLX: ${reply.error}`);

      const calls = reply.tool_calls ?? [];
      if (calls.length === 0) return reply.content ?? "";

      // 채팅 템플릿이 기대하는 형태로 되돌려 넣는다.
      // arguments 는 반드시 객체다 — Qwen 템플릿이 .items() 를 호출하므로
      // OpenAI API 처럼 JSON 문자열을 넣으면 렌더링이 실패한다.
      msgs.push({
        role: "assistant",
        content: reply.content ?? "",
        tool_calls: calls.map((c) => ({
          type: "function",
          function: { name: c.name, arguments: c.args ?? {} },
        })),
      });
      for (const c of calls) {
        const out = await onToolCall(c.name, c.args ?? {});
        msgs.push({ role: "tool", name: c.name, content: out, tool_call_id: randomUUID() });
      }
    }
    return "최대 턴 수를 초과했습니다. 작업을 더 작게 나눠 다시 요청하십시오.";
  }

  async close(): Promise<void> {
    this.rl?.close();
    this.proc?.kill();
    this.proc = undefined as never;
  }
}
