import { createInterface } from "node:readline/promises";
import type { Decision, ToolSpec } from "../types.ts";

export type Answer = "yes" | "no" | "always";

export interface ConsentUI {
  ask(req: {
    tool: ToolSpec;
    args: Record<string, unknown>;
    decision: Decision;
    preview: string;
  }): Promise<Answer>;
  info(msg: string): void;
  warn(msg: string): void;
}

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

/** 터미널 승인 UI. 개발자용이라 장식 없이 정보 밀도만 챙긴다. */
export class TerminalConsent implements ConsentUI {
  async ask(req: {
    tool: ToolSpec;
    args: Record<string, unknown>;
    decision: Decision;
    preview: string;
  }): Promise<Answer> {
    const { tool, decision, preview } = req;
    const irreversible = tool.reversibility === "R3";

    process.stdout.write(
      `\n${BOLD}┌─ 승인 요청 ─ ${tool.name}${RESET} ${DIM}[${tool.action} / ${tool.reversibility}]${RESET}\n`,
    );
    for (const line of preview.split("\n")) process.stdout.write(`${BOLD}│${RESET} ${line}\n`);
    process.stdout.write(`${BOLD}│${RESET} ${DIM}${decision.reason}${RESET}\n`);
    if (irreversible) {
      process.stdout.write(`${BOLD}│${RESET} ${RED}되돌릴 수 없는 작업입니다 (R3).${RESET}\n`);
    } else {
      process.stdout.write(`${BOLD}│${RESET} ${DIM}롤백 가능 · onmac undo${RESET}\n`);
    }

    // ask_always 와 R3 는 'a'(세션 전체 허용)를 제공하지 않는다.
    const canAlways = decision.verdict === "ask" && !irreversible;
    const hint = canAlways ? "[y] 실행  [n] 취소  [a] 이 세션 계속 허용" : "[y] 실행  [n] 취소";
    process.stdout.write(`${BOLD}└─${RESET} ${hint} > `);

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const raw = (await rl.question("")).trim().toLowerCase();
    rl.close();

    if (raw === "y" || raw === "yes") return "yes";
    if (canAlways && (raw === "a" || raw === "always")) return "always";
    return "no";
  }

  info(msg: string): void {
    process.stdout.write(`${DIM}${msg}${RESET}\n`);
  }

  warn(msg: string): void {
    process.stdout.write(`${YELLOW}⚠  ${msg}${RESET}\n`);
  }
}

/** 테스트/비대화 실행용. 모든 요청을 자동 거부한다 (기본 거부 원칙). */
export class AutoDenyConsent implements ConsentUI {
  readonly asked: string[] = [];
  async ask(req: { tool: ToolSpec }): Promise<Answer> {
    this.asked.push(req.tool.name);
    return "no";
  }
  info(): void {}
  warn(): void {}
}
