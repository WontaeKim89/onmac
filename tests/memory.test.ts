import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let MemoryStore: typeof import("../src/memory/store.ts").MemoryStore;
let chunkText: typeof import("../src/memory/store.ts").chunkText;
let indexRoots: typeof import("../src/memory/indexer.ts").indexRoots;
let PolicyEngine: typeof import("../src/core/policy.ts").PolicyEngine;

before(async () => {
  process.env["HOME"] = await mkdtemp(join(tmpdir(), "onmac-mem-home-"));
  ({ MemoryStore, chunkText } = await import("../src/memory/store.ts"));
  ({ indexRoots } = await import("../src/memory/indexer.ts"));
  ({ PolicyEngine } = await import("../src/core/policy.ts"));
});

/** 결정적 가짜 임베더 — 단어 겹침 기반. 순위 검증에 충분하다. */
const fakeEmbedder = {
  async embed(texts: string[]): Promise<number[][]> {
    const vocab = ["에러", "화면", "견적", "보험", "고양이", "터미널", "청구"];
    return texts.map((t) => vocab.map((w) => (t.includes(w) ? 1 : 0.01)));
  },
};

test("chunkText 는 겹침을 두고 자르고, 빈 입력엔 빈 배열", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("짧은 글"), ["짧은 글"]);
  const chunks = chunkText("가".repeat(3000), 1100, 180);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.length <= 1100));
});

test("저장 후 의미 순위대로 검색된다 — 파일당 최고 청크만", async () => {
  const store = new MemoryStore(join(await mkdtemp(join(tmpdir(), "mem-")), "m.sqlite"));
  const put = async (path: string, text: string) => {
    const [v] = await fakeEmbedder.embed([text]);
    store.replaceFile(path, 1, "text", [{ text, vec: Float32Array.from(v!) }]);
  };
  await put("/a/에러로그.txt", "터미널 에러 화면 캡처 내용");
  await put("/a/견적.txt", "누수 보험 청구 견적 문서");
  await put("/a/기타.txt", "고양이 사진 모음");

  const [qv] = await fakeEmbedder.embed(["에러 화면 찾아줘"]);
  const hits = store.search(Float32Array.from(qv!), 3);
  assert.equal(hits[0]!.path, "/a/에러로그.txt");
  assert.ok(hits[0]!.score > hits[1]!.score);
  store.close();
});

test("증분 색인 — mtime 이 같으면 needsIndex=false", async () => {
  const store = new MemoryStore(join(await mkdtemp(join(tmpdir(), "mem-")), "m.sqlite"));
  store.replaceFile("/x/a.txt", 1000, "text", [{ text: "t", vec: new Float32Array([1]) }]);
  assert.equal(store.needsIndex("/x/a.txt", 1000), false);
  assert.equal(store.needsIndex("/x/a.txt", 2000), true);
  assert.equal(store.needsIndex("/x/new.txt", 1), true);
  store.close();
});

test("색인기는 정책 deny 파일을 기억에 넣지 않는다 — 핵심 불변식", async () => {
  const root = await mkdtemp(join(tmpdir(), "onmac-idx-"));
  await writeFile(join(root, "노트.md"), "누수 보험 청구 관련 메모");
  // .env 는 dotfile 이라 워커 단계에서, .pem 은 확장자 필터에서 이미 걸러진다.
  // 정책 deny 경로가 실제로 작동하는지는 "색인 가능한 확장자 + deny 패턴" 으로 본다.
  await writeFile(join(root, ".env"), "SECRET_TOKEN=absolutely-not");
  await writeFile(join(root, "비밀메모.md"), "SECRET_TOKEN=absolutely-not");
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "node_modules", "junk.md"), "패키지 잡동사니");

  const policy = new PolicyEngine({
    roots: { allow: [root], deny: ["**/.env", "**/비밀*"] },
    actions: { read: "allow", list: "allow" } as never,
    limits: { maxFileMb: 200, maxFilesPerCall: 500 },
  });
  const store = new MemoryStore(join(root, "m.sqlite"));

  const prog = await indexRoots([root], policy, store, fakeEmbedder, undefined, {});
  assert.equal(prog.indexed, 1, "노트.md 하나만 색인되어야 한다");
  assert.ok(prog.skippedPolicy >= 1, ".env/.pem 은 정책 제외로 집계");

  // 인덱스 내용 어디에도 비밀이 없어야 한다
  const [qv] = await fakeEmbedder.embed(["SECRET_TOKEN"]);
  for (const h of store.search(Float32Array.from(qv!), 10)) {
    assert.ok(!h.snippet.includes("SECRET_TOKEN"), "비밀이 인덱스에 복제됨");
    assert.ok(!h.path.endsWith(".env"));
    assert.ok(!h.path.includes("비밀메모"));
  }
  store.close();
});

test("삭제된 파일은 인덱스에서도 사라진다", async () => {
  const root = await mkdtemp(join(tmpdir(), "onmac-idx-"));
  const f = join(root, "임시.md");
  await writeFile(f, "곧 지워질 문서");
  const policy = new PolicyEngine({
    roots: { allow: [root], deny: [] },
    actions: { read: "allow" } as never,
    limits: { maxFileMb: 200, maxFilesPerCall: 500 },
  });
  const store = new MemoryStore(join(root, "m.sqlite"));

  await indexRoots([root], policy, store, fakeEmbedder, undefined, {});
  assert.equal(store.stats().files, 1);

  const { rm } = await import("node:fs/promises");
  await rm(f);
  const prog2 = await indexRoots([root], policy, store, fakeEmbedder, undefined, {});
  assert.equal(prog2.removed, 1);
  assert.equal(store.stats().files, 0);
  store.close();
});
