import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

let buildExploreTools: typeof import("../src/tools/explore.ts").buildExploreTools;
let PolicyEngine: typeof import("../src/core/policy.ts").PolicyEngine;

before(async () => {
  process.env["HOME"] = await mkdtemp(join(tmpdir(), "onmac-ann-home-"));
  ({ buildExploreTools } = await import("../src/tools/explore.ts"));
  ({ PolicyEngine } = await import("../src/core/policy.ts"));
});

const ctx = { tx: { id: "t", record: async () => {} }, cwd: "/" };
const explore = () =>
  buildExploreTools(
    new PolicyEngine({
      roots: { allow: [homedir(), "/"], deny: [] },
      actions: { read: "allow" } as never,
      limits: { maxFileMb: 200, maxFilesPerCall: 500 },
    }),
  )[0]!;

test("SSID 가 가려진 출력에 '연결 안 됨이 아니다' 주석이 붙는다", async () => {
  const out = await explore().run({ command: "networksetup -getairportnetwork en0" }, ctx);

  // 이 맥이 실제로 네트워크에 붙어 있을 때만 주석이 의미 있다.
  // (CI 등 오프라인 환경에서는 주석 없이 원문만 나오는 것이 정상)
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const connected = await exec("ipconfig", ["getifaddr", "en0"])
    .then(({ stdout }) => stdout.trim().length > 0)
    .catch(() => false);

  if (!connected) {
    assert.ok(!out.includes("[onmac 주석]"), "연결이 없으면 주석을 붙이면 안 된다");
    return;
  }
  if (!/not associated|<redacted>/i.test(out)) return; // SSID 가 보이는 환경이면 대상 아님

  assert.match(out, /\[onmac 주석\]/);
  assert.match(out, /실제로 연결되어 있습니다/);
  assert.match(out, /위치 정보/);
  assert.ok(!/연결 안 됨입니다/.test(out));
});

test("무관한 명령에는 주석이 붙지 않는다", async () => {
  const out = await explore().run({ command: "sw_vers" }, ctx);
  assert.ok(!out.includes("[onmac 주석]"));
});
