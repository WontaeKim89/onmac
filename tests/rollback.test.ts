import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transaction } from "../src/core/tx.ts";
import { snapshot, atomicWrite, toTrash, exists } from "../src/core/snapshot.ts";

const tmp = () => mkdtemp(join(tmpdir(), "onmac-test-"));

test("하드링크 스냅샷 + atomicWrite 조합이 이전 내용을 보존한다", async () => {
  const dir = await tmp();
  const f = join(dir, "a.txt");
  await writeFile(f, "원본");

  const snap = await snapshot("tx-1", f);
  await atomicWrite(f, "수정됨");

  // 핵심: atomicWrite 가 새 inode 를 만들었기 때문에 하드링크는 옛 내용을 그대로 붙잡고 있다
  assert.equal(await readFile(f, "utf8"), "수정됨");
  assert.equal(await readFile(snap, "utf8"), "원본");
});

test("in-place 덮어쓰기는 스냅샷을 무효화한다 (atomicWrite 가 필요한 이유)", async () => {
  const dir = await tmp();
  const f = join(dir, "a.txt");
  await writeFile(f, "원본");
  const snap = await snapshot("tx-2", f);

  await writeFile(f, "제자리수정"); // atomicWrite 를 우회한 경우

  // 같은 inode 를 고쳤으므로 스냅샷도 함께 오염된다. 이래서 모든 쓰기가 atomicWrite 를 타야 한다.
  assert.equal(await readFile(snap, "utf8"), "제자리수정");
});

test("트랜잭션 롤백이 modify/create/move/delete 를 모두 되돌린다", async () => {
  const dir = await tmp();
  const keep = join(dir, "keep.txt");
  const moved = join(dir, "moved.txt");
  const target = join(dir, "sub", "moved.txt");
  const created = join(dir, "new.txt");
  const removed = join(dir, "gone.txt");

  await writeFile(keep, "before");
  await writeFile(moved, "m");
  await writeFile(removed, "d");

  const tx = await Transaction.begin("rollback-test");

  // modify
  const snap = await snapshot(tx.id, keep);
  await tx.record({ kind: "modify", path: keep, snap });
  await atomicWrite(keep, "after");

  // create
  await tx.record({ kind: "create", path: created });
  await atomicWrite(created, "new");

  // move
  await tx.record({ kind: "move", from: moved, to: target });
  await mkdir(join(dir, "sub"), { recursive: true });
  await (await import("node:fs/promises")).rename(moved, target);

  // delete
  const trash = await toTrash(tx.id, removed);
  await tx.record({ kind: "delete", path: removed, trash });

  // 변경이 실제로 반영됐는지 먼저 확인
  assert.equal(await readFile(keep, "utf8"), "after");
  assert.equal(await exists(created), true);
  assert.equal(await exists(moved), false);
  assert.equal(await exists(removed), false);

  const log = await tx.rollback();

  assert.equal(await readFile(keep, "utf8"), "before", "modify 복원 실패");
  assert.equal(await exists(created), false, "create 취소 실패");
  assert.equal(await readFile(moved, "utf8"), "m", "move 취소 실패");
  assert.equal(await readFile(removed, "utf8"), "d", "delete 취소 실패");
  assert.equal(log.length, 4);
});

test("롤백은 역순으로 수행된다 — 연쇄 이동도 복구된다", async () => {
  const dir = await tmp();
  const a = join(dir, "a.txt");
  const b = join(dir, "b.txt");
  const c = join(dir, "c.txt");
  await writeFile(a, "x");

  const tx = await Transaction.begin("chain");
  const { rename } = await import("node:fs/promises");

  await tx.record({ kind: "move", from: a, to: b });
  await rename(a, b);
  await tx.record({ kind: "move", from: b, to: c });
  await rename(b, c);

  await tx.rollback();
  assert.equal(await readFile(a, "utf8"), "x");
  assert.equal(await exists(c), false);
});

test("settingChange 는 복원 핸들러가 없으면 실패한다", async () => {
  const tx = await Transaction.begin("setting");
  await tx.record({ kind: "settingChange", key: "darkMode", before: "true", after: "false" });
  await assert.rejects(() => tx.rollback(), /복원 핸들러 미등록/);
});

test("settingChange 는 주입된 핸들러로 이전 값을 복원한다", async () => {
  const restored: Array<[string, string]> = [];
  const tx = await Transaction.begin("setting-ok", {
    restoreSetting: async (k, v) => void restored.push([k, v]),
  });
  await tx.record({ kind: "settingChange", key: "volume", before: "63", after: "10" });
  await tx.rollback();
  assert.deepEqual(restored, [["volume", "63"]]);
});

test("atomicWrite 는 임시파일을 남기지 않는다", async () => {
  const dir = await tmp();
  const f = join(dir, "a.txt");
  await atomicWrite(f, "x");
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(dir), ["a.txt"]);
  assert.ok((await stat(f)).size > 0);
});
