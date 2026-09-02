import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import type { Decision, Outcome, ToolSpec } from "../types.ts";
import { status } from "../ui/status.ts";
import { bold, dim, gray, green, red, yellow } from "../ui/theme.ts";

export type Answer = "yes" | "no" | "always";

export interface ConsentRequest {
  tool: ToolSpec;
  args: Record<string, unknown>;
  decision: Decision;
  preview: string;
  /** 결과-언어 서술. 있으면 사람 언어 카드로, 없으면 인자 나열로 렌더링한다. */
  outcome?: Outcome;
}

export interface ConsentUI {
  ask(req: ConsentRequest): Promise<Answer>;
  info(msg: string): void;
  warn(msg: string): void;
}

const short = (s: string) => s.replace(homedir(), "~");

/**
 * 터미널 승인 UI.
 *
 * 카드의 언어가 곧 이 제품의 보안 UX 다. 사용자가 판단에 필요한 것은
 * 툴 이름이 아니라 세 줄이다 — 무엇이 바뀌나 / 무엇을 잃나 / 잘못되면 어떻게 되나.
 * 위험 등급(R1/R3)은 기호가 아니라 "잘못되면" 줄의 내용과 색으로 전달한다.
 * 전문가용 정보(툴 이름·액션·등급)는 카드 아래 흐린 한 줄로 층을 나눈다.
 */
export class TerminalConsent implements ConsentUI {
  async ask(req: ConsentRequest): Promise<Answer> {
    const { tool, decision, outcome } = req;
    const irreversible = tool.reversibility === "R3";

    // 진행 표시가 돌고 있으면 프롬프트와 같은 줄에서 충돌한다. 반드시 먼저 멈춘다.
    status.pause();

    const bar = irreversible ? red("┃") : yellow("┃");
    const w = process.stdout.columns ?? 80;
    const line = (s = "") => process.stdout.write(`${bar} ${s}\n`);

    process.stdout.write("\n");

    if (outcome) {
      line(bold(outcome.title));
      line(dim("─".repeat(Math.min(w - 2, 56))));
      line(`${gray("바뀌는 것 ")} ${short(outcome.changes)}`);
      line(`${gray("사라지는 것")} ${short(outcome.loses)}`);
      line(
        irreversible
          ? `${gray("잘못되면 ")} ${red(outcome.recover)}`
          : `${gray("잘못되면 ")} ${green(outcome.recover)}`,
      );
      line(dim(`자세히: ${tool.name} · ${tool.action} · ${tool.reversibility} · ${decision.reason}`));
    } else {
      // 결과 서술이 없는 툴 — 전문가 뷰로 떨어진다
      line(`${bold("승인 요청")}  ${bold(tool.name)}  ${gray(`${tool.action} · ${tool.reversibility}`)}`);
      line(dim("─".repeat(Math.min(w - 2, 56))));
      for (const l of req.preview.split("\n")) line(short(l));
      line(
        dim(decision.reason) +
          (irreversible ? "  " + red("이 작업은 undo 로 되돌릴 수 없습니다") : "  " + dim("onmac undo 로 되돌릴 수 있습니다")),
      );
    }

    const canAlways = decision.verdict === "ask" && !irreversible;
    const opts = canAlways
      ? `${green("y")} 실행   ${red("n")} 취소   ${yellow("a")} 이 세션은 계속 허용`
      : `${green("y")} 실행   ${red("n")} 취소`;
    line(opts);
    process.stdout.write(`${bar} `);

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

  /**
   * 승급 신청 카드 — 시스템이 실적을 들고 사용자에게 위임을 묻는다.
   * 결정은 항상 사람이 한다. 임계 도달 시 자동 전환 같은 것은 없다.
   */
  async proposePromotion(tool: ToolSpec, stat: { approvals: number; denials: number }): Promise<"promote" | "keepAsking"> {
    status.pause();
    const bar = green("┃");
    const line = (s = "") => process.stdout.write(`${bar} ${s}\n`);
    process.stdout.write("\n");
    line(`${bold(`"${tool.description.split(".")[0]}" — 이제 안 물어봐도 될까요?`)}`);
    line(dim(`승인 ${stat.approvals}회 · 거절 ${stat.denials}회 · 되돌림 0회`));
    line(dim("맡겨도 전부 기록되고, 되돌리는 순간 다시 물어보기 시작합니다."));
    line(`${green("y")} 맡길게요   ${yellow("n")} 계속 물어봐 주세요`);
    process.stdout.write(`${bar} `);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const raw = (await rl.question("")).trim().toLowerCase();
    rl.close();
    return raw === "y" || raw === "yes" ? "promote" : "keepAsking";
  }
}

/** 테스트/비대화 실행용. 모든 요청을 자동 거부한다 (기본 거부 원칙). */
export class AutoDenyConsent implements ConsentUI {
  readonly asked: string[] = [];
  async ask(req: ConsentRequest): Promise<Answer> {
    this.asked.push(req.tool.name);
    return "no";
  }
  info(): void {}
  warn(): void {}
}
