import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import type { Decision, ToolSpec } from "../types.ts";
import { status } from "../ui/status.ts";
import { bold, dim, gray, green, red, yellow } from "../ui/theme.ts";

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

const short = (s: string) => s.replace(homedir(), "~");

const RISK: Record<string, string> = {
  R0: gray("무해"),
  R1: green("되돌릴 수 있음"),
  R2: green("되돌릴 수 있음"),
  R3: red("되돌릴 수 없음"),
};

/** 터미널 승인 UI. 장식보다 "무엇이 바뀌는가"의 가독성을 우선한다. */
export class TerminalConsent implements ConsentUI {
  async ask(req: {
    tool: ToolSpec;
    args: Record<string, unknown>;
    decision: Decision;
    preview: string;
  }): Promise<Answer> {
    const { tool, decision, preview } = req;
    const irreversible = tool.reversibility === "R3";

    // 진행 표시가 돌고 있으면 프롬프트와 같은 줄에서 충돌한다. 반드시 먼저 멈춘다.
    status.pause();

    const bar = irreversible ? red("┃") : yellow("┃");
    const w = process.stdout.columns ?? 80;

    process.stdout.write("\n");
    process.stdout.write(
      `${bar} ${bold("승인 요청")}  ${bold(tool.name)}  ${gray(`${tool.action} · ${RISK[tool.reversibility]}`)}\n`,
    );
    process.stdout.write(`${bar} ${dim("─".repeat(Math.min(w - 2, 60)))}\n`);
    for (const line of preview.split("\n")) {
      process.stdout.write(`${bar} ${short(line)}\n`);
    }
    process.stdout.write(
      `${bar} ${dim(decision.reason)}${irreversible ? "  " + red("이 작업은 undo 로 되돌릴 수 없습니다") : "  " + dim("onmac undo 로 되돌릴 수 있습니다")}\n`,
    );

    const canAlways = decision.verdict === "ask" && !irreversible;
    const opts = canAlways
      ? `${green("y")} 실행   ${red("n")} 취소   ${yellow("a")} 이 세션 계속 허용`
      : `${green("y")} 실행   ${red("n")} 취소`;
    process.stdout.write(`${bar} ${opts}\n${bar} `);

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const raw = (await rl.question("")).trim().toLowerCase();
    rl.close();

    if (raw === "y" || raw === "yes") return "yes";
    if (canAlways && (raw === "a" || raw === "always")) return "always";
    return "no";
  }

  info(msg: string): void {
    status.pause();
    process.stdout.write(`${dim(msg)}\n`);
  }

  warn(msg: string): void {
    status.pause();
    process.stdout.write(`${yellow("⚠")}  ${msg}\n`);
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
