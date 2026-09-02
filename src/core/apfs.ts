import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * APFS 로컬 스냅샷 — 셸이 무엇을 하든 되돌릴 수 있게 만드는 안전망.
 *
 * Time Machine 이 쓰는 그 기능이다. copy-on-write 라 생성이 몇 초, 용량이 거의 0.
 * 다만 `tmutil localsnapshot` 은 sudo 가 필요해서 기본값이 꺼져 있다 —
 * 켠 사용자에게만 apply 툴의 등급이 R3 → R1 로 내려간다.
 *
 * 복원은 볼륨 전체를 되돌리지 않는다. 스냅샷을 읽기 전용으로 마운트해 필요한
 * 파일만 꺼내는 방식이 안전하다 (전체 롤백은 사용자의 다른 작업까지 날린다).
 */

export async function snapshotsAvailable(): Promise<boolean> {
  try {
    // sudo 비밀번호 없이 실행 가능한지 확인 (-n = non-interactive)
    await exec("sudo", ["-n", "tmutil", "listlocalsnapshots", "/"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function latestSnapshotName(): Promise<string | undefined> {
  try {
    const { stdout } = await exec("tmutil", ["listlocalsnapshots", "/"], { timeout: 10_000 });
    const names = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("com.apple.TimeMachine."));
    return names.at(-1);
  } catch {
    return undefined;
  }
}

export async function takeVolumeSnapshot(): Promise<void> {
  await exec("sudo", ["-n", "tmutil", "localsnapshot"], { timeout: 120_000 });
}

/**
 * 스냅샷을 읽기 전용으로 마운트하고 경로를 돌려준다.
 * 되돌리기는 여기서 파일을 복사해 오는 방식이다.
 */
export async function mountSnapshot(name: string): Promise<string> {
  const mnt = `/tmp/onmac-snap-${Date.now()}`;
  await exec("mkdir", ["-p", mnt]);
  await exec("sudo", ["-n", "mount_apfs", "-o", "ro", "-s", name, "/System/Volumes/Data", mnt], {
    timeout: 60_000,
  });
  return mnt;
}

export async function unmountSnapshot(mnt: string): Promise<void> {
  try {
    await exec("sudo", ["-n", "umount", mnt], { timeout: 30_000 });
  } catch {
    /* 이미 해제됨 */
  }
}
