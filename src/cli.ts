#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { load, init, packageRoot, USER_CONFIG, resolveConfigPath } from "./core/config.ts";
import { Agent, buildBackend, INVERSE_HANDLERS } from "./agent.ts";
import { TerminalConsent } from "./core/consent.ts";
import { listTransactions, undo } from "./core/tx.ts";
import * as audit from "./core/audit.ts";
import { renderBanner, HELP } from "./ui/banner.ts";
import { question, closePrompt } from "./ui/prompt.ts";
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

  try {
    for (;;) {
      // Ctrl+D 나 파이프 입력의 EOF 는 정상 종료다. 에러로 취급하지 않는다.
      const raw = await question(`${bold(cyan("›"))} `);
      if (raw === null) break;
      const line = raw.trim();
      if (!line) continue;

      // 사용자 입력을 형광펜처럼 다시 칠한다 — AI 출력과 한눈에 구분되도록
      if (process.stdout.isTTY) {
        process.stdout.write(`\x1b[1A\x1b[2K\x1b[48;5;58m\x1b[38;5;230m\x1b[1m › ${line} \x1b[0m\n`);
      }

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
        if (line === "/model") {
          if (cfg.llm.backend !== "mlx") {
            process.stdout.write(`  ${dim("모델 전환은 mlx 백엔드에서만 지원됩니다.")}\n\n`);
            continue;
          }
          const { scanModels } = await import("./core/models.ts");
          const found = await scanModels();
          if (found.length === 0) {
            process.stdout.write(`  ${dim("models/ 에 설치된 모델이 없습니다.")}\n\n`);
            continue;
          }
          const { selectOption } = await import("./ui/select.ts");
          const current = cfg.llm.mlx.modelPath;
          const r = await selectOption(
            "",
            found.map((m: { name: string; path: string; sizeGb: string }) => ({
              label: `${m.name}  ${m.path === current ? "(현재)" : ""}`,
              hint: `${m.sizeGb}GB`,
            })),
          );
          const chosen = found[r.index]!;
          if (chosen.path === current) {
            process.stdout.write(`  ${dim("이미 사용 중인 모델입니다.")}\n\n`);
            continue;
          }
          const backend = (agent as unknown as { backend?: unknown }).backend;
          status.start(`${chosen.name} 로 교체 중 (기존 모델 메모리 해제 → 새 모델 적재)`);
          try {
            const t0 = Date.now();
            await (agent.swapModel as (p: string) => Promise<void>).call(agent, chosen.path);
            status.done(`교체 완료 — ${chosen.name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
            const { persistMlxModelPath, divergentConfigPaths } = await import("./core/models.ts");
            await persistMlxModelPath(cfg.configPath, chosen.path);
            process.stdout.write(`  ${dim(`저장: ${short(cfg.configPath)}`)}\n`);

            // 모델 선택은 프로젝트별 취향이 아니라 기계 단위 취향이다.
            // 다른 설정 파일이 있으면 같이 맞출지 물어본다 — 안 그러면 실행 위치마다 딴 모델이 뜬다.
            const others = await divergentConfigPaths(cfg.configPath);
            if (others.length > 0) {
              const { selectOption: sel2 } = await import("./ui/select.ts");
              process.stdout.write(
                `  ${yellow("⚠")}  다른 설정 파일 ${others.length}개가 다른 모델을 가리킵니다.\n`,
              );
              const yn = await sel2("", [
                { label: "전부 이 모델로 맞추기", key: "y" },
                { label: "이 설정만 바꾸기", key: "n" },
              ]);
              if (yn.index === 0) {
                for (const o of others) {
                  try {
                    await persistMlxModelPath(o, chosen.path);
                    process.stdout.write(`  ${dim(`저장: ${short(o)}`)}\n`);
                  } catch {
                    process.stdout.write(`  ${dim(`건너뜀: ${short(o)}`)}\n`);
                  }
                }
              }
            }
            process.stdout.write("\n");
          } catch (e) {
            status.fail(`교체 실패: ${e instanceof Error ? e.message : String(e)}`);
          }
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
            // 사용자 입력(›)과 AI 응답을 시각적으로 가른다
            process.stdout.write(`\n${green("⏺")} `);
          }
          streamed += d.length;
          process.stdout.write(d.replace(/\n/g, "\n  "));
        });
        status.pause();
        // 스트리밍으로 이미 화면에 찍혔으면 본문을 다시 출력하지 않는다
        process.stdout.write(
          streamed > 0 ? "\n\n" : `\n${green("⏺")} ${answer.replace(/\n/g, "\n  ")}\n\n`,
        );

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
    closePrompt();
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

    case "models": {
      const { scanModels, otherConfigModels } = await import("./core/models.ts");
      const cfg2 = await load();
      process.stdout.write(`\n  ${dim("설정")} ${short(cfg2.configPath)}\n\n`);
      for (const m of await scanModels()) {
        const cur = m.path === cfg2.llm.mlx.modelPath ? green(" ← 이 설정의 모델") : "";
        process.stdout.write(`  ${bold(m.name.padEnd(24))} ${dim(m.sizeGb + "GB")}${cur}\n`);
      }
      // 설정 파일이 여러 개면 실행 위치에 따라 다른 모델이 뜬다 — 실제로 혼동을 부른 지점이다
      const others = await otherConfigModels(cfg2.configPath);
      if (others.length > 0) {
        process.stdout.write(`\n  ${yellow("⚠")}  다른 설정 파일은 다른 모델을 가리킵니다 — 실행 위치에 따라 바뀝니다:\n`);
        for (const o of others) {
          process.stdout.write(`     ${dim(short(o.configPath))} → ${o.modelName}\n`);
        }
      }
      process.stdout.write(dim(`\n  대화 중 /model 로 전환 · 추가 설치: .venv/bin/hf download <mlx-community/…> --local-dir models/<이름>\n\n`));
      return;
    }

    case "watch": {
      const cfg = await load();
      if (cfg.llm.backend !== "mlx") {
        process.stderr.write("감시는 mlx 백엔드에서만 동작합니다.\n");
        process.exit(1);
      }
      const withImages = !rest.includes("--no-images");
      const { MlxBackend } = await import("./llm/mlx.ts");
      const { MemoryStore } = await import("./memory/store.ts");
      const { MemoryWatcher, catchUp } = await import("./memory/watcher.ts");
      const { PolicyEngine } = await import("./core/policy.ts");

      const backend = new MlxBackend({
        modelPath: cfg.llm.mlx.modelPath,
        embedModelPath: cfg.llm.mlx.embedModelPath,
        python: cfg.llm.mlx.python,
        projectRoot: packageRoot,
        maxTurns: 1,
        thinking: false,
        maxKvSize: cfg.llm.maxKvSize,
      });
      const store = new MemoryStore();
      const policy = new PolicyEngine(cfg.policy);

      process.stdout.write(
        `\n  ${bold("onmac watch")} ${dim("— 상주 기억")}\n` +
          `  ${dim(`감시 ${cfg.policy.roots.allow.length}곳 · 이미지 판독 ${withImages ? "켬" : "끔"} · Ctrl+C 로 종료`)}\n\n`,
      );

      if (withImages) {
        status.start("비전 모델 적재 중 (한 번만)");
        await backend.warmup();
        status.done("준비 완료 — 이제부터 새 파일을 즉시 기억합니다");
      }

      const missed = await catchUp(cfg.policy.roots.allow, store);
      if (missed.length > 0) {
        process.stdout.write(dim(`  꺼져 있는 동안 바뀐 파일 ${missed.length}건 — onmac index 로 따라잡을 수 있습니다\n\n`));
      }

      const watcher = new MemoryWatcher({
        roots: cfg.policy.roots.allow,
        policy,
        store,
        embedder: backend,
        ...(withImages ? { describer: backend } : {}),
        images: withImages,
        onIndexed: (e) => {
          const icon = e.kind === "image" ? "🖼" : "📄";
          const t = new Date().toTimeString().slice(0, 8);
          process.stdout.write(`  ${dim(t)} ${icon} ${bold(short(e.path))}\n      ${dim(e.summary)}\n`);
          // "전에도 이거 보셨어요" — 사용자가 시키지 않았는데 먼저 아는 순간
          if (e.echo) {
            process.stdout.write(
              `      ${green("↳")} 비슷한 것을 ${bold(e.echo.when)} 에도 보셨습니다: ${dim(short(e.echo.path))}\n`,
            );
          }
        },
      });
      watcher.start();

      await new Promise<void>((resolve) => {
        const bye = () => {
          watcher.stop();
          store.close();
          void backend.close();
          process.stdout.write(dim("\n  감시를 종료했습니다.\n"));
          resolve();
        };
        process.on("SIGINT", bye);
        process.on("SIGTERM", bye);
      });
      return;
    }

    case "index": {
      const cfg = await load();
      if (cfg.llm.backend !== "mlx") {
        process.stderr.write("색인은 mlx 백엔드에서만 동작합니다.\n");
        process.exit(1);
      }
      const withImages = rest.includes("--images");
      const { MlxBackend } = await import("./llm/mlx.ts");
      const { MemoryStore } = await import("./memory/store.ts");
      const { indexRoots } = await import("./memory/indexer.ts");
      const { PolicyEngine } = await import("./core/policy.ts");

      const backend = new MlxBackend({
        modelPath: cfg.llm.mlx.modelPath,
        embedModelPath: cfg.llm.mlx.embedModelPath,
        python: cfg.llm.mlx.python,
        projectRoot: packageRoot,
        maxTurns: cfg.llm.maxTurns,
        thinking: false,
        maxKvSize: cfg.llm.maxKvSize,
      });
      const store = new MemoryStore();
      const policy = new PolicyEngine(cfg.policy);

      status.start(withImages ? "색인 중 (이미지 포함 — VLM 적재에 시간이 걸립니다)" : "색인 중");
      let count = 0;
      try {
        const prog = await indexRoots(
          cfg.policy.roots.allow,
          policy,
          store,
          backend,
          withImages ? backend : undefined,
          {
            images: withImages,
            onFile: (path, what) => {
              if (what !== "skip") status.update(`${what === "describe" ? "이미지 판독" : "색인"} ${++count} · ${short(path).slice(-60)}`);
            },
          },
        );
        const s2 = store.stats();
        status.done(
          `색인 완료 — 파일 ${s2.files}개(이미지 ${s2.images}) · 청크 ${s2.chunks} · ` +
            `신규/갱신 ${prog.indexed} · 정책 제외 ${prog.skippedPolicy} · 판독 실패 ${prog.imageFailures} · 삭제 반영 ${prog.removed}`,
        );
        if (!withImages) {
          process.stdout.write(dim("  스크린샷·이미지까지 색인하려면: onmac index --images\n"));
        }
      } finally {
        store.close();
        await backend.close();
      }
      return;
    }

    case "recall": {
      const q = rest.join(" ").trim();
      if (!q) return void process.stdout.write("사용법: onmac recall <찾을 내용>\n");
      const cfg = await load();
      const { MlxBackend } = await import("./llm/mlx.ts");
      const { MemoryStore } = await import("./memory/store.ts");
      const backend = new MlxBackend({
        modelPath: cfg.llm.mlx.modelPath,
        embedModelPath: cfg.llm.mlx.embedModelPath,
        python: cfg.llm.mlx.python,
        projectRoot: packageRoot,
        maxTurns: 1,
        thinking: false,
        maxKvSize: cfg.llm.maxKvSize,
      });
      const store = new MemoryStore();
      try {
        const [vec] = await backend.embed([q], "query");
        for (const h of store.search(Float32Array.from(vec!), 8)) {
          const when = new Date(h.mtimeMs).toISOString().slice(0, 10);
          process.stdout.write(
            `${green(h.score.toFixed(3))}  ${dim(when)}  ${h.kind === "image" ? "🖼 " : "📄"} ${short(h.path)}\n  ${dim(h.snippet.replace(/\n/g, " ").slice(0, 110))}\n`,
          );
        }
      } finally {
        store.close();
        await backend.close();
      }
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
          `  onmac models           설치된 모델 목록 (대화 중 /model 로 전환)\n` +
          `  onmac watch            상주 감시 — 새 파일을 생기는 즉시 기억\n` +
          `  onmac index [--images] 회상 인덱스 구축 (허용 경로의 문서·스크린샷)\n` +
          `  onmac recall <질문>     인덱스에서 바로 검색\n` +
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
