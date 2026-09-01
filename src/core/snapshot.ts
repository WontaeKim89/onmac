import { link, mkdir, rename, writeFile, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const ONMAC_DIR = join(homedir(), ".onmac");
export const SNAP_DIR = join(ONMAC_DIR, "snapshots");
export const TRASH_DIR = join(ONMAC_DIR, "trash");

const shortHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/**
 * 작업 전 원본을 하드링크로 붙잡아둔다.
 *
 * 하드링크는 "같은 데이터를 가리키는 두 번째 이름표"라 복사가 아니다 — 용량 0, 소요 1ms 미만.
 * 단 이 방식은 원본이 in-place 로 덮어써지면 무효가 된다. 그래서 onmac 의 모든 쓰기는
 * 반드시 atomicWrite() 를 거쳐야 한다. 두 함수는 한 쌍으로만 의미가 있다.
 */
export async function snapshot(txId: string, path: string): Promise<string> {
  const dst = join(SNAP_DIR, txId, `${shortHash(path)}-${randomUUID().slice(0, 8)}`);
  await mkdir(dirname(dst), { recursive: true });
  await link(path, dst);
  return dst;
}

/**
 * 원자적 쓰기. 임시파일에 쓴 뒤 rename 으로 교체한다.
 *
 * 두 가지를 동시에 보장한다.
 *   1) 쓰기 도중 프로세스가 죽어도 원본이 반쯤 망가지지 않는다 (rename 은 원자적)
 *   2) 새 데이터가 새 inode 에 생기므로 snapshot() 의 하드링크가 옛 내용을 계속 붙잡는다
 */
export async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  const tmp = `${path}.onmac-${randomUUID().slice(0, 8)}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/** 삭제 대신 휴지통으로 이동. 트랜잭션 롤백과 `onmac undo` 양쪽에서 복구 가능하다. */
export async function toTrash(txId: string, path: string): Promise<string> {
  const dst = join(TRASH_DIR, txId, `${shortHash(path)}-${randomUUID().slice(0, 8)}`);
  await mkdir(dirname(dst), { recursive: true });
  await rename(path, dst);
  return dst;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
