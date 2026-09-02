import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

let buildExploreTools: typeof import("../src/tools/explore.ts").buildExploreTools;
let buildApplyTool: typeof import("../src/tools/apply.ts").buildApplyTool;
let PolicyEngine: typeof import("../src/core/policy.ts").PolicyEngine;

before(async () => {
  process.env["HOME"] = await mkdtemp(join(tmpdir(), "onmac-exp-home-"));
  ({ buildExploreTools } = await import("../src/tools/explore.ts"));
  ({ buildApplyTool } = await import("../src/tools/apply.ts"));
  ({ PolicyEngine } = await import("../src/core/policy.ts"));
});

const ctx = { tx: { id: "t", record: async () => {} }, cwd: "/" };

function policyFor(root: string, deny: string[]) {
  return new PolicyEngine({
    roots: { allow: [root], deny },
    actions: { read: "allow", shell: "ask" } as never,
    limits: { maxFileMb: 200, maxFilesPerCall: 500 },
  });
}

test("explore 는 임의 읽기 명령을 실행한다 — 화이트리스트 없음", async () => {
  const [explore] = buildExploreTools(policyFor(homedir(), []));
  const out = await explore!.run({ command: "sw_vers && echo --- && uname -m" }, ctx);
  assert.match(out, /macOS|ProductName/i);
  assert.match(out, /arm64/);
});

test("explore 는 승인이 필요 없는 read 액션이다", () => {
  const [explore] = buildExploreTools(policyFor(homedir(), []));
  assert.equal(explore!.action, "read");
  assert.equal(explore!.reversibility, "R0");
});

test("explore 가 쓰기성 명령을 거부한다", async () => {
  const [explore] = buildExploreTools(policyFor(homedir(), []));
  for (const cmd of ["rm -rf /tmp/x", "mv a b", "echo hi > /tmp/f", "curl http://x", "defaults write com.x y"]) {
    const out = await explore!.run({ command: cmd }, ctx);
    assert.match(out, /읽기 전용|거부/, `통과되면 안 됨: ${cmd}`);
  }
});

test("샌드박스가 정책 deny 경로 읽기를 OS 레벨에서 막는다 — 핵심 불변식", async () => {
  const root = await mkdtemp(join(tmpdir(), "onmac-sb-"));
  const secretDir = join(root, "secrets");
  await mkdir(secretDir);
  await writeFile(join(secretDir, "key.txt"), "TOP-SECRET-VALUE");
  await writeFile(join(root, "ok.txt"), "public");

  const [explore] = buildExploreTools(policyFor(root, [`${secretDir}/**`]));

  const allowed = await explore!.run({ command: `cat ${join(root, "ok.txt")}` }, ctx);
  assert.match(allowed, /public/);

  // 화이트리스트가 아니라 커널이 막는다 — cat 이라는 "허용된 명령"으로도 못 읽는다
  const blocked = await explore!.run({ command: `cat ${join(secretDir, "key.txt")}` }, ctx);
  assert.ok(!blocked.includes("TOP-SECRET-VALUE"), "보호 경로가 셸로 유출됨");
  assert.match(blocked, /보호|permitted|실패/);
});

test("apply 는 스냅샷이 꺼져 있으면 R3, 켜져 있으면 R1", () => {
  assert.equal(buildApplyTool({ snapshotsEnabled: false }).reversibility, "R3");
  assert.equal(buildApplyTool({ snapshotsEnabled: true }).reversibility, "R1");
});

test("apply 의 승인 카드가 되돌리기 가능 여부를 정직하게 말한다", () => {
  const off = buildApplyTool({ snapshotsEnabled: false }).describe!({ command: "brew install x", expect: "설치" });
  assert.match(off.recover, /되돌릴 수 없습니다/);
  const on = buildApplyTool({ snapshotsEnabled: true }).describe!({ command: "brew install x", expect: "설치" });
  assert.match(on.recover, /스냅샷|되돌릴 수 있습니다/);
});
