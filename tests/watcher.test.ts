import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let MemoryWatcher: typeof import("../src/memory/watcher.ts").MemoryWatcher;
let catchUp: typeof import("../src/memory/watcher.ts").catchUp;
let MemoryStore: typeof import("../src/memory/store.ts").MemoryStore;
let PolicyEngine: typeof import("../src/core/policy.ts").PolicyEngine;

before(async () => {
  process.env["HOME"] = await mkdtemp(join(tmpdir(), "onmac-watch-home-"));
  ({ MemoryWatcher, catchUp } = await import("../src/memory/watcher.ts"));
  ({ MemoryStore } = await import("../src/memory/store.ts"));
  ({ PolicyEngine } = await import("../src/core/policy.ts"));
});

const fakeEmbedder = {
  async embed(texts: string[]): Promise<number[][]> {
    const vocab = ["에러", "타임아웃", "견적", "보험", "고양이", "터미널"];
    return texts.map((t) => vocab.map((w) => (t.includes(w) ? 1 : 0.01)));
  },
};

const waitFor = async (cond: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 150));
  return cond();
};

function setup(root: string, deny: string[] = []) {
  const store = new MemoryStore(join(root, "m.sqlite"));
  const policy = new PolicyEngine({
    roots: { allow: [root], deny },
    actions: { read: "allow" } as never,
    limits: { maxFileMb: 200, maxFilesPerCall: 500 },
  });
  const events: Array<{ path: string; summary: string; echo?: unknown }> = [];
  const watcher = new MemoryWatcher({
    roots: [root],
    policy,
    store,
    embedder: fakeEmbedder,
    images: false,
    onIndexed: (e) => events.push(e),
  });
  return { store, watcher, events };
}

test("새 파일이 생기면 알아서 기억한다 — 시키지 않아도", async () => {
  const root = await mkdtemp(join(tmpdir(), "onmac-w-"));
  const { store, watcher, events } = setup(root);
  watcher.start();
  try {
    await writeFile(join(root, "노트.md"), "langfuse 타임아웃 에러 관련 메모");
    assert.ok(await waitFor(() => events.length > 0), "감시자가 새 파일을 잡지 못함");
    assert.match(events[0]!.path, /노트\.md$/);
    assert.equal(store.stats().files, 1);
  } finally {
    watcher.stop();
    store.close();
  }
});

test("정책이 막은 파일은 기억에도 들어오지 않는다", async () => {
  const root = await mkdtemp(join(tmpdir(), "onmac-w-"));
  const { store, watcher, events } = setup(root, ["**/비밀*"]);
  watcher.start();
  try {
    await writeFile(join(root, "비밀메모.md"), "SECRET_TOKEN=absolutely-not");
    await writeFile(join(root, "공개.md"), "보험 견적 정리");
    assert.ok(await waitFor(() => events.length > 0));
    await new Promise((r) => setTimeout(r, 1200)); // 뒤늦게 들어올 여지를 준다
    assert.ok(
      events.every((e) => !e.path.includes("비밀메모")),
      "정책 차단 파일이 감시자를 통해 색인됨",
    );
  } finally {
    watcher.stop();
    store.close();
  }
});

test("dotfile 과 node_modules 는 감시 대상이 아니다", async () => {
  const root = await mkdtemp(join(tmpdir(), "onmac-w-"));
  const { store, watcher, events } = setup(root);
  watcher.start();
  try {
    await writeFile(join(root, ".env"), "SECRET=1");
    await writeFile(join(root, "진짜.md"), "에러 로그");
    assert.ok(await waitFor(() => events.length > 0));
    await new Promise((r) => setTimeout(r, 1200));
    assert.ok(events.every((e) => !e.path.endsWith(".env")));
  } finally {
    watcher.stop();
    store.close();
  }
});

test("catchUp 은 데몬이 꺼져 있던 동안 바뀐 파일을 찾아낸다", async () => {
  const root = await mkdtemp(join(tmpdir(), "onmac-w-"));
  const store = new MemoryStore(join(root, "m.sqlite"));
  try {
    await writeFile(join(root, "a.md"), "하나");
    await writeFile(join(root, "b.md"), "둘");
    const missed = await catchUp([root], store);
    assert.equal(missed.length, 2);

    // 하나를 색인해두면 나머지 하나만 남는다
    store.replaceFile(join(root, "a.md"), (await import("node:fs")).statSync(join(root, "a.md")).mtimeMs, "text", [
      { text: "하나", vec: new Float32Array([1]) },
    ]);
    const missed2 = await catchUp([root], store);
    assert.equal(missed2.length, 1);
    assert.match(missed2[0]!, /b\.md$/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
