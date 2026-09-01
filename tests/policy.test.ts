import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { PolicyEngine, type PolicyConfig } from "../src/core/policy.ts";

const CFG: PolicyConfig = {
  roots: {
    allow: ["~/Desktop", "~/Downloads"],
    deny: ["~/.ssh/**", "**/.env", "**/.env.*", "**/*.pem"],
  },
  actions: {
    read: "allow",
    list: "allow",
    write: "ask",
    move: "ask",
    delete: "ask_always",
    shell: "ask",
    app_control: "ask",
    settings: "ask",
    ui_control: "deny",
  },
  limits: { maxFileMb: 200, maxFilesPerCall: 500 },
};

const pe = () => new PolicyEngine(CFG);
const HOME = homedir();

test("허용 루트 안의 읽기는 통과한다", () => {
  assert.equal(pe().check("read", `${HOME}/Desktop/a.txt`).verdict, "allow");
});

test("deny 는 allow 를 이긴다 — 허용 루트 안의 .env 도 차단", () => {
  const d = pe().check("read", `${HOME}/Desktop/PROJECT/repo/.env`);
  assert.equal(d.verdict, "deny");
  assert.match(d.reason, /보호 대상/);
});

test("deny 는 확장 패턴에도 적용된다 (.env.local, *.pem)", () => {
  assert.equal(pe().check("read", `${HOME}/Desktop/.env.local`).verdict, "deny");
  assert.equal(pe().check("read", `${HOME}/Downloads/cert.pem`).verdict, "deny");
});

test("경로 우회(..)를 막는다", () => {
  // ~/Desktop 은 허용이지만 ../.ssh 로 빠져나가면 안 된다
  assert.equal(pe().check("read", `${HOME}/Desktop/../.ssh/id_rsa`).verdict, "deny");
});

test("허용 루트 밖은 거부한다", () => {
  assert.equal(pe().check("read", "/etc/passwd").verdict, "deny");
  assert.equal(pe().check("read", `${HOME}/Library/Keychains/x`).verdict, "deny");
});

test("허용 루트와 이름만 비슷한 형제 디렉토리는 통과하지 못한다", () => {
  // ~/Desktop 이 허용이라고 ~/DesktopEvil 이 허용되면 안 된다
  assert.equal(pe().check("read", `${HOME}/DesktopEvil/a.txt`).verdict, "deny");
});

test("정책이 deny 인 액션은 대상과 무관하게 차단된다", () => {
  assert.equal(pe().check("ui_control", `${HOME}/Desktop`).verdict, "deny");
});

test("세션 승인은 write 에는 적용되지만 delete 에는 적용되지 않는다", () => {
  const p = pe();
  const target = `${HOME}/Desktop/a.txt`;

  assert.equal(p.check("write", target).verdict, "ask");
  p.grantForSession("write", target);
  assert.equal(p.check("write", target).verdict, "allow");

  // delete 는 ask_always — 세션 승인을 넣어도 계속 물어야 한다
  p.grantForSession("delete", target);
  assert.equal(p.check("delete", target).verdict, "ask_always");
});

test("세션 승인은 승인한 그 대상에만 적용된다", () => {
  const p = pe();
  p.grantForSession("write", `${HOME}/Desktop/a.txt`);
  assert.equal(p.check("write", `${HOME}/Desktop/b.txt`).verdict, "ask");
});

test("정책에 없는 액션은 기본 거부", () => {
  assert.equal(pe().check("shell" as never, undefined).verdict, "ask");
  const bare = new PolicyEngine({ ...CFG, actions: {} });
  assert.equal(bare.check("read", `${HOME}/Desktop/a.txt`).verdict, "deny");
});
