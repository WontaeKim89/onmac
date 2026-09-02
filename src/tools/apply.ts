import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolSpec, Reversibility } from "../types.ts";
import { takeVolumeSnapshot, latestSnapshotName } from "../core/apfs.ts";

const exec = promisify(execFile);

/**
 * 변경 층 — 전용 툴로 안 되는 모든 것의 탈출로.
 *
 * Claude Code 는 bash 를 주는 대신 되돌리기를 포기했다. 우리는 둘 다 갖는다:
 * APFS 볼륨 스냅샷을 먼저 찍고 셸을 돌리면, 셸이 무엇을 하든 그 시점으로
 * 되돌아갈 수 있다. 스냅샷이 켜져 있으면 등급이 R1(복구 가능)로 내려가고,
 * 꺼져 있으면 R3(복구 불가) 그대로다 — 등급이 사용자에게 정직하게 표시된다.
 */
export function buildApplyTool(opts: {
  snapshotsEnabled: boolean;
}): ToolSpec {
  const reversibility: Reversibility = opts.snapshotsEnabled ? "R1" : "R3";

  return {
    name: "apply",
    description:
      "시스템을 변경하는 임의의 셸 명령을 실행한다. 전용 툴(write_file/move_file/" +
      "delete_file/set_dark_mode 등)로 되는 일은 그쪽을 쓰라 — 더 정확히 되돌릴 수 있다. " +
      "설치·설정 변경·앱 제어처럼 전용 툴이 없는 경우에만 사용하라.",
    action: "shell",
    reversibility,
    describe: (a) => ({
      title: "터미널 명령을 실행할게요",
      changes: `실행: ${String(a["command"] ?? "")}`,
      loses: String(a["expect"] ?? "명령에 따라 다릅니다 — onmac 이 효과를 미리 알 수 없습니다"),
      recover: opts.snapshotsEnabled
        ? "실행 직전 볼륨 스냅샷을 찍어두므로 onmac undo 로 되돌릴 수 있습니다"
        : "되돌릴 수 없습니다. onmac settings 에서 볼륨 스냅샷을 켜면 되돌리기가 가능해집니다",
    }),
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "실행할 명령 한 줄" },
        expect: { type: "string", description: "이 명령이 무엇을 바꾸는지 한 줄 설명 (승인 카드에 표시)" },
        timeoutSec: { type: "number", description: "제한 시간(초), 기본 60" },
      },
      required: ["command", "expect"],
    },
    async run(args, ctx) {
      const command = String(args["command"] ?? "").trim();
      if (!command) throw new Error("command 가 비어 있습니다.");

      // 실행 전에 되돌릴 준비부터 (write-ahead). 순서를 바꾸면 복구가 깨진다.
      if (opts.snapshotsEnabled) {
        const before = await latestSnapshotName();
        await takeVolumeSnapshot();
        const after = await latestSnapshotName();
        if (after && after !== before) {
          await ctx.tx.record({ kind: "volumeSnapshot", name: after, reason: command.slice(0, 80) });
        }
      }

      const timeout = Math.min(600, Math.max(1, Number(args["timeoutSec"] ?? 60))) * 1000;
      const { stdout, stderr } = await exec("/bin/zsh", ["-c", command], {
        timeout,
        maxBuffer: 8 * 1024 * 1024,
      });
      const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n--- stderr ---\n");
      return out.slice(0, 8000) || "(출력 없음)";
    },
  };
}
