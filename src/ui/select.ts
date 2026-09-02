import { emitKeypressEvents } from "node:readline";
import { ANSI, bold, cyan, dim, green, isTTY } from "./theme.ts";
import { pausePrompt, resumePrompt, question } from "./prompt.ts";

/**
 * 방향키 선택 컴포넌트.
 *
 * ↑↓ 로 고르고 Enter. 마지막에 "직접 입력…" 을 붙일 수 있다(자유 텍스트).
 * TTY 가 아니면(파이프·테스트) 텍스트 질문으로 폴백해서 자동화가 깨지지 않는다.
 */

export interface SelectOption {
  label: string;
  /** 폴백(텍스트 모드)에서 이 키를 입력하면 이 항목이 선택된다. 예: "y" */
  key?: string;
  hint?: string;
}

export interface SelectResult {
  index: number;
  /** "직접 입력" 을 골랐을 때의 텍스트 */
  other?: string;
}

export async function selectOption(
  title: string,
  options: SelectOption[],
  opts: { allowOther?: boolean; otherLabel?: string; barColor?: (s: string) => string } = {},
): Promise<SelectResult> {
  const bar = opts.barColor ?? cyan;
  const items = [...options];
  const otherIndex = opts.allowOther ? items.length : -1;
  if (opts.allowOther) items.push({ label: opts.otherLabel ?? "직접 입력…", key: "o" });

  /* ── 폴백: 파이프/테스트 환경 — 키 문자로 답한다 ── */
  if (!isTTY) {
    const legend = items.map((o, i) => `${o.key ?? i + 1}=${o.label}`).join("  ");
    const raw = ((await question(`${title} [${legend}] > `)) ?? "").trim().toLowerCase();
    let idx = items.findIndex((o) => o.key === raw);
    if (idx < 0) idx = Number(raw) - 1;
    if (idx < 0 || idx >= items.length) idx = items.length - 1; // 못 알아들으면 마지막(보수적) 항목
    if (idx === otherIndex) {
      const text = ((await question("  입력: ")) ?? "").trim();
      return { index: otherIndex, other: text };
    }
    return { index: idx };
  }

  /* ── TTY: 방향키 선택 ── */
  let cursor = 0;
  let lines = 0;

  const render = () => {
    const out: string[] = [];
    items.forEach((o, i) => {
      const here = i === cursor;
      const marker = here ? bar("❯") : " ";
      const label = here ? bold(o.label) : dim(o.label);
      out.push(` ${marker} ${label}${o.hint && here ? `  ${dim(o.hint)}` : ""}`);
    });
    const text = out.join("\n");
    process.stdout.write((lines ? ANSI.up(lines) : "") + text.split("\n").map((l) => `\x1b[2K${l}`).join("\n") + "\n");
    lines = out.length;
  };

  pausePrompt(); // 공유 readline 과 키 입력 경쟁 금지 (실측 버그의 교훈)
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write(ANSI.hideCursor);
  render();

  const picked = await new Promise<number>((resolve) => {
    const onKey = (_s: string, k: { name?: string; ctrl?: boolean }) => {
      if (k.name === "up" || k.name === "k") cursor = (cursor - 1 + items.length) % items.length;
      else if (k.name === "down" || k.name === "j") cursor = (cursor + 1) % items.length;
      else if (k.name === "return") {
        cleanup();
        return resolve(cursor);
      } else if (k.name === "escape" || (k.ctrl && k.name === "c")) {
        cleanup();
        return resolve(items.findIndex((o) => o.key === "n") >= 0 ? items.findIndex((o) => o.key === "n") : cursor);
      } else {
        // 단축키 직접 입력 (y/n/a/o)
        const idx = items.findIndex((o) => o.key === k.name);
        if (idx >= 0) {
          cleanup();
          return resolve(idx);
        }
        return;
      }
      render();
    };
    const cleanup = () => {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode(false);
      process.stdout.write(ANSI.showCursor);
      resumePrompt();
    };
    process.stdin.on("keypress", onKey);
  });

  // 선택지 목록을 지우고 선택 결과 한 줄로 축약
  process.stdout.write(ANSI.up(lines) + Array(lines).fill("\x1b[2K").join("\n") + ANSI.up(lines - 1));
  process.stdout.write(`\x1b[2K ${green("❯")} ${items[picked]!.label}\n`);

  if (picked === otherIndex) {
    const text = ((await question(`   ${dim("입력:")} `)) ?? "").trim();
    return { index: otherIndex, other: text };
  }
  return { index: picked };
}
