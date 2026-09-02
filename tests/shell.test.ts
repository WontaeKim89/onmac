import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// trust 테스트와 같은 이유로 HOME 을 먼저 격리한다 (audit 이 ~/.onmac 에 쓴다)
let shellTools: typeof import("../src/tools/shell.ts").shellTools;
let executeToolCall: typeof import("../src/core/executor.ts").executeToolCall;
let Transaction: typeof import("../src/core/tx.ts").Transaction;
let PolicyEngine: typeof import("../src/core/policy.ts").PolicyEngine;

before(async () => {
  process.env["HOME"] = await mkdtemp(join(tmpdir(), "onmac-shell-home-"));
  ({ shellTools } = await import("../src/tools/shell.ts"));
  ({ executeToolCall } = await import("../src/core/executor.ts"));
  ({ Transaction } = await import("../src/core/tx.ts"));
  ({ PolicyEngine } = await import("../src/core/policy.ts"));
});

const query = () => shellTools.find((t) => t.name === "run_system_query")!;
const cmd = () => shellTools.find((t) => t.name === "run_command")!;
const ctx = { tx: { id: "t", record: async () => {} }, cwd: "/" };

test("화이트리스트 조회 명령은 실행된다", async () => {
  const out = await query().run({ command: "sw_vers" }, ctx);
  assert.match(out, /macOS|ProductName/i);
});

test("화이트리스트 밖 명령은 조회 툴에서 거절된다", async () => {
  const out = await query().run({ command: "rm -rf /tmp/x" }, ctx);
  assert.match(out, /화이트리스트에 없는/);
});

test("파일 읽기 명령은 조회 툴로 우회할 수 없다 (deny 우회 차단)", async () => {
  for (const c of ["cat ~/.ssh/id_rsa", "head -1 /etc/passwd", "ls ~/.ssh"]) {
    const out = await query().run({ command: c }, ctx);
    assert.match(out, /화이트리스트에 없는/, `뚫림: ${c}`);
  }
});

test("run_command 는 R3 라 세션 승인 대상이 아니고, shell=deny 정책이면 차단된다", async () => {
  assert.equal(cmd().reversibility, "R3");

  const pe = new PolicyEngine({
    roots: { allow: ["/tmp"], deny: [] },
    actions: { shell: "deny", read: "allow" } as never,
    limits: { maxFileMb: 200, maxFilesPerCall: 500 },
  });
  const tx = await Transaction.begin("shell-deny");
  const consent = { asked: [] as string[], async ask() { return "yes" as const; }, info() {}, warn() {} };
  const out = await executeToolCall(
    { id: "1", name: "run_command", args: { command: "echo hi" } },
    { policy: pe, consent: consent as never, tools: new Map([["run_command", cmd()]]), cwd: "/tmp" },
    tx,
  );
  assert.match(out, /거부됨/);
});

test("run_command 는 shell=ask 에서 승인 후 실행된다", async () => {
  const pe = new PolicyEngine({
    roots: { allow: ["/tmp"], deny: [] },
    actions: { shell: "ask" } as never,
    limits: { maxFileMb: 200, maxFilesPerCall: 500 },
  });
  const tx = await Transaction.begin("shell-ask");
  const asked: string[] = [];
  const consent = { async ask(r: { tool: { name: string } }) { asked.push(r.tool.name); return "yes" as const; }, info() {}, warn() {} };
  const out = await executeToolCall(
    { id: "1", name: "run_command", args: { command: "echo onmac-shell-ok" } },
    { policy: pe, consent: consent as never, tools: new Map([["run_command", cmd()]]), cwd: "/tmp" },
    tx,
  );
  assert.deepEqual(asked, ["run_command"]);
  assert.match(out, /onmac-shell-ok/);
});
