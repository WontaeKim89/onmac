import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// 주의: TrustLedger 와 audit 은 ~/.onmac 고정 경로를 쓴다. 테스트가 실제 장부를
// 오염시키지 않도록 HOME 을 임시 디렉토리로 바꾼 뒤에 모듈을 로드한다.
let TrustLedger: typeof import("../src/core/trust.ts").TrustLedger;
let audit: typeof import("../src/core/audit.ts");
let executeToolCall: typeof import("../src/core/executor.ts").executeToolCall;
let Transaction: typeof import("../src/core/tx.ts").Transaction;
let PolicyEngine: typeof import("../src/core/policy.ts").PolicyEngine;
let fsTools: typeof import("../src/tools/fs.ts").fsTools;

before(async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "onmac-trust-home-"));
  process.env["HOME"] = fakeHome;
  assert.equal(homedir(), fakeHome, "HOME 재지정 실패 — 테스트가 실제 장부를 건드릴 수 있다");
  ({ TrustLedger } = await import("../src/core/trust.ts"));
  audit = await import("../src/core/audit.ts");
  ({ executeToolCall } = await import("../src/core/executor.ts"));
  ({ Transaction } = await import("../src/core/tx.ts"));
  ({ PolicyEngine } = await import("../src/core/policy.ts"));
  ({ fsTools } = await import("../src/tools/fs.ts"));
});

const CFG = () => ({
  roots: { allow: [homedir()], deny: ["**/.env"] },
  actions: {
    read: "allow", list: "allow", write: "ask", move: "ask", delete: "ask_always",
  } as Record<string, "allow" | "ask" | "ask_always" | "deny">,
  limits: { maxFileMb: 200, maxFilesPerCall: 500 },
});

class AutoYes {
  readonly asked: string[] = [];
  async ask(req: { tool: { name: string } }) {
    this.asked.push(req.tool.name);
    return "yes" as const;
  }
  info() {}
  warn() {}
}

test("임계 도달 + 되돌림 0 이면 승급 자격이 생긴다", async () => {
  const t = new TrustLedger(3);
  for (let i = 0; i < 3; i++) await t.recordDecision("move_file", "approved");
  const moveTool = fsTools.find((x) => x.name === "move_file")!;
  const props = await t.eligibleProposals([moveTool]);
  assert.equal(props.length, 1);
  assert.equal(props[0]!.tool.name, "move_file");
});

test("임계 미달이면 제안하지 않는다", async () => {
  const t = new TrustLedger(30);
  for (let i = 0; i < 5; i++) await t.recordDecision("move_file", "approved");
  assert.equal((await t.eligibleProposals(fsTools)).length, 0);
});

test("삭제(ask_always)는 어떤 실적으로도 승급 대상이 아니다", async () => {
  const t = new TrustLedger(1);
  for (let i = 0; i < 100; i++) await t.recordDecision("delete_file", "approved");
  const delTool = fsTools.find((x) => x.name === "delete_file")!;
  // delete_file 은 R1 이라 reversibility 필터는 통과하지만, executor 게이트가
  // ask_always 를 위임 불가로 재확인한다 — 아래 게이트 테스트에서 검증.
  // 여기서는 승급되어 mode=auto 여도 실행이 자동화되지 않음을 확인한다.
  await t.promote("delete_file");
  assert.equal(await t.isAuto("delete_file"), true, "장부상 auto 로 만들 수는 있다");

  const dir = await mkdtemp(join(tmpdir(), "onmac-t-"));
  const f = join(dir, "a.txt");
  await writeFile(f, "x");
  const consent = new AutoYes();
  const tx = await Transaction.begin("del-guard");
  const env = {
    policy: new PolicyEngine({ ...CFG(), roots: { allow: [dir], deny: [] } }),
    consent: consent as never,
    tools: new Map([[delTool.name, delTool]]),
    cwd: dir,
    trust: t,
  };
  await executeToolCall({ id: "1", name: "delete_file", args: { path: f } }, env, tx);
  assert.deepEqual(consent.asked, ["delete_file"], "auto 여도 삭제는 반드시 물어야 한다");
});

test("위임된 유형은 승인 없이 실행되고 audit 에 auto 로 남는다", async () => {
  const t = new TrustLedger(1);
  await t.promote("write_file");
  const writeTool = fsTools.find((x) => x.name === "write_file")!;

  const dir = await mkdtemp(join(tmpdir(), "onmac-t-"));
  const consent = new AutoYes();
  const tx = await Transaction.begin("auto-write");
  const env = {
    policy: new PolicyEngine({ ...CFG(), roots: { allow: [dir], deny: [] } }),
    consent: consent as never,
    tools: new Map([[writeTool.name, writeTool]]),
    cwd: dir,
    trust: t,
  };
  const out = await executeToolCall(
    { id: "1", name: "write_file", args: { path: join(dir, "b.txt"), content: "hi" } },
    env,
    tx,
  );
  assert.equal(consent.asked.length, 0, "위임 상태에서는 묻지 않아야 한다");
  assert.match(out, /작성 완료/);
  assert.equal(await readFile(join(dir, "b.txt"), "utf8"), "hi");

  const entries = await audit.forTx(tx.id);
  assert.equal(entries.at(-1)?.verdict, "auto");
});

test("위임 상태여도 deny 경로는 여전히 차단된다 — 신뢰는 정책을 이길 수 없다", async () => {
  const t = new TrustLedger(1);
  await t.promote("write_file");
  const writeTool = fsTools.find((x) => x.name === "write_file")!;
  const dir = await mkdtemp(join(tmpdir(), "onmac-t-"));
  const tx = await Transaction.begin("deny-beats-trust");
  const env = {
    policy: new PolicyEngine({ ...CFG(), roots: { allow: [dir], deny: ["**/.env"] } }),
    consent: new AutoYes() as never,
    tools: new Map([[writeTool.name, writeTool]]),
    cwd: dir,
    trust: t,
  };
  const out = await executeToolCall(
    { id: "1", name: "write_file", args: { path: join(dir, ".env"), content: "T=1" } },
    env,
    tx,
  );
  assert.match(out, /거부됨/);
});

test("undo 는 해당 트랜잭션의 유형을 강등하고 undos 를 올린다", async () => {
  const t = new TrustLedger(1);
  await t.promote("move_file");
  const tx = await Transaction.begin("demote-src");
  await audit.write({
    txId: tx.id, action: "move", tool: "move_file", args: {}, verdict: "auto", reason: "t",
  });

  const demoted = await t.demoteForTx(tx.id);
  assert.deepEqual(demoted, ["move_file"]);
  assert.equal(await t.isAuto("move_file"), false);
  const snap = await t.snapshot();
  assert.equal(snap["move_file"]!.undos, 1);

  // 되돌림 이력이 생긴 유형은 다시 임계를 채워도 제안되지 않는다
  const moveTool = fsTools.find((x) => x.name === "move_file")!;
  for (let i = 0; i < 5; i++) await t.recordDecision("move_file", "approved");
  assert.equal((await t.eligibleProposals([moveTool])).length, 0);
});

test("제안을 거절한 유형은 다시 조르지 않는다", async () => {
  const t = new TrustLedger(2);
  // 장부 파일이 테스트 간 공유되므로 고유한 유형명을 쓴다
  const tool = { ...fsTools.find((x) => x.name === "write_file")!, name: "decline_test_tool" };
  for (let i = 0; i < 4; i++) await t.recordDecision(tool.name, "approved");
  assert.equal((await t.eligibleProposals([tool])).length, 1);
  await t.declineProposal(tool.name);
  assert.equal((await t.eligibleProposals([tool])).length, 0);
});

test("revokeAll 은 모든 위임을 해제하되 통계는 남긴다", async () => {
  const t = new TrustLedger(1);
  await t.revokeAll(); // 앞선 테스트들의 위임 흔적을 청소 (장부 파일은 테스트 간 공유된다)
  await t.recordDecision("revoke_test_tool", "approved");
  await t.promote("revoke_test_tool");
  await t.promote("revoke_test_tool_2");
  const n = await t.revokeAll();
  assert.equal(n, 2);
  assert.equal(await t.isAuto("revoke_test_tool"), false);
  const snap = await t.snapshot();
  assert.equal(snap["revoke_test_tool"]!.approvals, 1, "이력은 사실이므로 지우지 않는다");
});
