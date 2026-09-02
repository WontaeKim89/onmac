#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { load, init, packageRoot, USER_CONFIG, resolveConfigPath } from "./core/config.ts";
import { Agent, buildBackend, INVERSE_HANDLERS } from "./agent.ts";
import { TerminalConsent } from "./core/consent.ts";
import { listTransactions, undo } from "./core/tx.ts";
import * as audit from "./core/audit.ts";
import { renderBanner, HELP } from "./ui/banner.ts";
import { status } from "./ui/status.ts";
import { bold, cyan, dim, gray, green, red, yellow } from "./ui/theme.ts";

const short = (s: string) => s.replace(homedir(), "~");

async function version(): Promise<string> {
  try {
    return JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const RISK_LABEL: Record<string, string> = {
  R0: gray("무해"),
  R1: green("파일 복구 가능"),
  R2: green("역연산 복구"),
  R3: red("복구 불가"),
};

async function chat(): Promise<void> {
  const cfg = await load();
  const agent = new Agent(cfg, buildBackend(cfg), new TerminalConsent());

  process.stdout.write(
    renderBanner({
      version: await version(),
      backend: cfg.llm.backend,
      model: basename(cfg.llm.backend === "mlx" ? cfg.llm.mlx.modelPath : cfg.llm.llamacpp.modelPath),
      toolCount: agent.toolNames.length,
      configPath: short(cfg.configPath),
      allowRoots: cfg.policy.roots.allow.length,
    }),
  );

  // 모델 로딩을 첫 질문 뒤가 아니라 여기서 끝낸다.
  // 30초를 기다리게 하더라도, 기다리는 줄 아는 상태로 기다리게 해야 한다.
  status.start("모델 적재 중");
  try {
    await agent.warmup();
    status.done("준비 완료");
  } catch (e) {
    status.fail(`모델 적재 실패: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  process.stdout.write("\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });

  try {
    for (;;) {
      if (closed) break;
      // Ctrl+D 나 파이프 입력의 EOF 는 정상 종료다. 에러로 취급하지 않는다.
      let raw: string;
      try {
        raw = await rl.question(`${cyan("›")} `);
      } catch {
        break;
      }
      const line = raw.trim();
      if (!line) continue;

      if (line.startsWith("/")) {
        if (line === "/quit" || line === "/exit") break;
        if (line === "/help") {
          process.stdout.write(HELP + "\n");
          continue;
        }
        if (line === "/tools") {
          for (const t of agent.toolSpecs) {
            process.stdout.write(
              `  ${bold(t.name.padEnd(20))} ${gray(t.action.padEnd(12))} ${RISK_LABEL[t.reversibility]}\n      ${dim(t.description)}\n`,
            );
          }
          process.stdout.write("\n");
          continue;
        }
        if (line === "/policy") {
          process.stdout.write(`  ${bold("허용 루트")}\n`);
          for (const r of cfg.policy.roots.allow) process.stdout.write(`    ${green("+")} ${r}\n`);
          process.stdout.write(`  ${bold("차단 패턴")}\n`);
          for (const r of cfg.policy.roots.deny) process.stdout.write(`    ${red("-")} ${r}\n`);
          process.stdout.write(`  ${bold("액션")}  ${dim(JSON.stringify(cfg.policy.actions))}\n\n`);
          continue;
        }
        if (line === "/settings") {
          const { runSettings } = await import("./ui/settings.ts");
          const changed = await runSettings(cfg);
          if (changed) {
            process.stdout.write(
              `  ${yellow("⚠")}  변경한 정책은 다음 실행부터 적용됩니다. ${dim("(현재 세션은 시작 시점 정책으로 계속됩니다)")}\n\n`,
            );
          }
          continue;
        }
        if (line === "/stats") {
          const s = (agent as unknown as { backendStats?: Record<string, unknown> }).backendStats;
          process.stdout.write(
            s
              ? `  ${dim(JSON.stringify(s))}\n\n`
              : `  ${dim("아직 실측치가 없습니다. 질문을 한 번 해보십시오.")}\n\n`,
          );
          continue;
        }
        if (line === "/clear") {
          agent.clearHistory();
          process.stdout.write(`  ${dim("대화 기록을 비웠습니다. 모델은 그대로 올라가 있습니다.")}\n\n`);
          continue;
        }
        if (line === "/undo") {
          try {
            const r = await undo(undefined, INVERSE_HANDLERS);
            process.stdout.write(r.log.map((l) => `  ${green("↩")} ${short(l)}`).join("\n") + "\n");
            // 되돌리기 = 신뢰 회수. 이 트랜잭션에 참여한 유형은 다시 물어보기 시작한다.
            const demoted = await agent.trust.demoteForTx(r.txId);
            if (demoted.length) {
              process.stdout.write(`  ${dim(`위임 해제: ${demoted.join(", ")} — 다시 물어봅니다`)}\n`);
            }
            process.stdout.write("\n");
          } catch (e) {
            process.stdout.write(`  ${yellow("⚠")}  ${e instanceof Error ? e.message : String(e)}\n\n`);
          }
          continue;
        }
        process.stdout.write(`  ${dim("알 수 없는 명령. /help 참고")}\n\n`);
        continue;
      }

      status.start("thinking");
      try {
        let streamed = 0;
        const answer = await agent.ask(line, [], (d) => {
          if (streamed === 0) {
            status.pause();
            process.stdout.write("\n");
          }
          streamed += d.length;
          process.stdout.write(d);
        });
        status.pause();
        // 스트리밍으로 이미 화면에 찍혔으면 본문을 다시 출력하지 않는다
        process.stdout.write(streamed > 0 ? "\n\n" : `\n${answer}\n\n`);

        // 실적이 쌓인 유형이 있으면 시스템이 승급을 신청한다. 결정은 사용자가.
        const consentUi = new TerminalConsent();
        for (const p of await agent.trust.eligibleProposals(agent.toolSpecs)) {
          const choice = await consentUi.proposePromotion(p.tool, p.stat);
          if (choice === "promote") {
            await agent.trust.promote(p.tool.name);
            process.stdout.write(`  ${green("✔")} ${dim(`${p.tool.name} 위임됨 — 되돌리는 순간 다시 물어봅니다`)}\n\n`);
          } else {
            await agent.trust.declineProposal(p.tool.name);
            process.stdout.write(`  ${dim("계속 물어볼게요.")}\n\n`);
          }
        }
      } catch (e) {
        status.fail(e instanceof Error ? e.message : String(e));
        process.stdout.write("\n");
      }
    }
  } finally {
    status.pause();
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

    case "settings":
    case "config": {
      const cfg = await load();
      const { runSettings } = await import("./ui/settings.ts");
      await runSettings(cfg);
      return;
    }

    case "init": {
      const target = rest.includes("--here") ? join(process.cwd(), "onmac.toml") : USER_CONFIG;
      const path = await init(target);
      process.stdout.write(
        `${green("✔")} 설정 생성: ${short(path)}\n\n` +
          `  ${bold("onmac 의 세 가지 약속")}\n` +
          `  1. 비밀은 읽지 않습니다 — 키·인증서·환경변수 파일은 허용 폴더 안에 있어도 차단됩니다.\n` +
          `  2. 모든 변경은 되돌릴 수 있습니다 — "되돌려줘" 또는 onmac undo.\n` +
          `  3. 인터넷에 연결되지 않습니다 — 네트워크 기능이 코드에 존재하지 않습니다.\n\n` +
          `  ${dim("[roots] allow 를 본인 환경에 맞게 수정한 뒤")} onmac ${dim("을 실행하십시오.")}\n` +
          `  ${dim("현재 디렉토리 기준으로 다른 정책을 쓰고 싶으면")} onmac init --here\n`,
      );
      return;
    }

    case "where": {
      const path = await resolveConfigPath();
      process.stdout.write(
        `설정: ${path ? short(path) : dim("(없음 — onmac init)")}\n패키지: ${short(packageRoot)}\n`,
      );
      return;
    }

    case "history": {
      const txs = await listTransactions();
      if (txs.length === 0) return void process.stdout.write("기록 없음\n");
      const color = { committed: green, rolledback: gray, open: yellow } as const;
      for (const t of txs.slice(0, 30)) {
        const when = new Date(t.ts).toISOString().replace("T", " ").slice(0, 19);
        process.stdout.write(
          `${when}  ${color[t.state](t.state.padEnd(11))} ${String(t.opCount).padStart(3)}건  ${t.label}\n${dim("  " + t.id)}\n`,
        );
      }
      return;
    }

    case "undo": {
      const i = rest.indexOf("--tx");
      const txId = i >= 0 ? rest[i + 1] : undefined;
      const r = await undo(txId, INVERSE_HANDLERS);
      process.stdout.write(
        r.log.length ? r.log.map((l) => `${green("↩")} ${short(l)}`).join("\n") + "\n" : "되돌릴 변경이 없습니다.\n",
      );
      const { TrustLedger } = await import("./core/trust.ts");
      const demoted = await new TrustLedger(30).demoteForTx(r.txId);
      if (demoted.length) process.stdout.write(dim(`위임 해제: ${demoted.join(", ")} — 다시 물어봅니다\n`));
      return;
    }

    case "trust": {
      const { TrustLedger } = await import("./core/trust.ts");
      const audit2 = await import("./core/audit.ts");
      const ledger = new TrustLedger(30);

      if (rest.includes("--revoke-all")) {
        const n = await ledger.revokeAll();
        process.stdout.write(`${green("✔")} 위임 ${n}건을 해제했습니다. 이제 전부 다시 물어봅니다.\n`);
        return;
      }

      const cats = await ledger.snapshot();
      const t = await audit2.tally();
      const approvals = Object.values(cats).reduce((a, c) => a + c.approvals, 0);
      const undos = Object.values(cats).reduce((a, c) => a + c.undos, 0);

      process.stdout.write(`\n  ${bold("onmac 신뢰 현황")}\n\n`);
      process.stdout.write(
        `  지금까지 한 일 ${bold(String(t.total))}   승인 ${green(String(approvals))}   ` +
          `되돌림 ${yellow(String(undos))}   차단된 시도 ${t.blocked > 0 ? red(String(t.blocked)) : dim("0")}\n\n`,
      );
      const names = Object.keys(cats).sort();
      if (names.length === 0) {
        process.stdout.write(`  ${dim("아직 기록이 없습니다. 쓰다 보면 여기서 위임을 관리하게 됩니다.")}\n\n`);
        return;
      }
      for (const name of names) {
        const c = cats[name]!;
        const mode = c.mode === "auto" ? green("맡김  ") : yellow("물어봄");
        process.stdout.write(
          `  ${mode}  ${name.padEnd(20)} ${dim(`승인 ${c.approvals} · 거절 ${c.denials} · 되돌림 ${c.undos}`)}\n`,
        );
      }
      process.stdout.write(`\n  ${dim("전부 다시 물어보게 하려면: onmac trust --revoke-all")}\n\n`);
      return;
    }

    case "audit": {
      if (rest.includes("--verify")) {
        const r = await audit.verify();
        process.stdout.write(
          r.ok
            ? `${green("✔")} 감사 로그 무결성 정상 (${r.total}건)\n`
            : `${red("✖")} ${r.brokenAt}번째 레코드에서 체인이 깨졌습니다. 로그가 변조되었을 수 있습니다.\n`,
        );
        return;
      }
      for (const e of await audit.read(50)) {
        process.stdout.write(
          `${dim(e.ts.slice(0, 19))}  ${e.verdict.padEnd(12)} ${bold(e.tool)}  ${dim(short(JSON.stringify(e.args)).slice(0, 80))}\n`,
        );
      }
      return;
    }

    case "--version":
    case "-v":
      process.stdout.write(`onmac ${await version()}\n`);
      return;

    default:
      process.stdout.write(
        `\n  ${bold("onmac")} ${dim("— 승인 기반 오프라인 로컬 Mac 에이전트")}\n\n` +
          `  onmac                  대화 시작\n` +
          `  onmac settings         보안 설정 화면 (방향키 + 스페이스)\n` +
          `  onmac init [--here]    설정 파일 생성\n` +
          `  onmac where            어떤 설정을 쓰는지 확인\n` +
          `  onmac trust            신뢰 현황 · --revoke-all 로 전량 회수\n` +
          `  onmac history          되돌릴 수 있는 변경 이력\n` +
          `  onmac undo [--tx ID]   되돌리기\n` +
          `  onmac audit [--verify] 감사 로그 / 무결성 검증\n\n`,
      );
  }
}

main().catch((e) => {
  status.pause();
  process.stderr.write(`\n${red("✖")} ${e instanceof Error ? e.message : String(e)}\n\n`);
  process.exit(1);
});
