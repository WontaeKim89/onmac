#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { load } from "./core/config.ts";
import { Agent, buildBackend, INVERSE_HANDLERS } from "./agent.ts";
import { TerminalConsent } from "./core/consent.ts";
import { listTransactions, undo } from "./core/tx.ts";
import * as audit from "./core/audit.ts";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

async function chat(): Promise<void> {
  const cfg = await load();
  const consent = new TerminalConsent();
  const agent = new Agent(cfg, buildBackend(cfg), consent);

  process.stdout.write(
    `onmac ${DIM}· backend=${cfg.llm.backend} · 툴 ${agent.toolNames.length}개 · 네트워크 없음${RESET}\n` +
      `${DIM}종료: Ctrl+D · 되돌리기: 다른 터미널에서 onmac undo${RESET}\n\n`,
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const line = (await rl.question("> ")).trim();
      if (!line) continue;
      if (line === "/quit" || line === "/exit") break;
      try {
        process.stdout.write(`\n${await agent.ask(line)}\n\n`);
      } catch (e) {
        process.stderr.write(`\n오류: ${e instanceof Error ? e.message : String(e)}\n\n`);
      }
    }
  } finally {
    rl.close();
    await agent.close();
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case undefined:
    case "chat":
      return chat();

    case "history": {
      const txs = await listTransactions();
      if (txs.length === 0) return void process.stdout.write("기록 없음\n");
      for (const t of txs.slice(0, 30)) {
        const when = new Date(t.ts).toISOString().replace("T", " ").slice(0, 19);
        process.stdout.write(`${when}  ${t.state.padEnd(11)} ${String(t.opCount).padStart(3)}건  ${t.label}\n${DIM}  ${t.id}${RESET}\n`);
      }
      return;
    }

    case "undo": {
      const i = rest.indexOf("--tx");
      const txId = i >= 0 ? rest[i + 1] : undefined;
      const log = await undo(txId, INVERSE_HANDLERS);
      process.stdout.write(log.length ? log.join("\n") + "\n" : "되돌릴 변경이 없습니다.\n");
      return;
    }

    case "audit": {
      if (rest.includes("--verify")) {
        const r = await audit.verify();
        process.stdout.write(
          r.ok
            ? `감사 로그 무결성 정상 (${r.total}건)\n`
            : `⚠  ${r.brokenAt}번째 레코드에서 체인이 깨졌습니다. 로그가 변조되었을 수 있습니다.\n`,
        );
        return;
      }
      for (const e of await audit.read(50)) {
        process.stdout.write(`${e.ts.slice(0, 19)}  ${e.verdict.padEnd(12)} ${e.tool}  ${JSON.stringify(e.args).slice(0, 90)}\n`);
      }
      return;
    }

    default:
      process.stdout.write(
        `onmac — 승인 기반 로컬 Mac 에이전트\n\n` +
          `  onmac              대화 시작\n` +
          `  onmac history      되돌릴 수 있는 변경 이력\n` +
          `  onmac undo [--tx ID]  마지막(또는 지정) 변경 되돌리기\n` +
          `  onmac audit [--verify]  감사 로그 조회 / 무결성 검증\n`,
      );
  }
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
