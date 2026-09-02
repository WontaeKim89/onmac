import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolSpec } from "../types.ts";

const exec = promisify(execFile);

/**
 * 범용 실행 층 — 포장도로(전용 툴)가 못 가는 곳의 탈출로.
 *
 * 전용 툴만으로는 커버리지가 유한하다 ("와이파이 뭐야?" 사례). 그렇다고 전부
 * shell 로 돌리면 결과 분류·롤백·신뢰 승급이 전부 무너진다 — Claude Code 에
 * undo 가 없는 이유가 그것이다. 그래서 두 단계로 나눈다:
 *
 *   run_system_query — 시스템 정보 조회 화이트리스트. 파일을 읽지 않는 명령만.
 *                      action=read 라 묻지 않는다. 롱테일 질문의 대부분이 여기서 끝난다.
 *   run_command      — 진짜 임의 명령. action=shell(ask) + R3.
 *                      명령 전문이 승인 카드에 뜨고, 어떤 실적으로도 위임되지 않는다.
 *
 * shell 사용은 전부 감사로그에 남는다. 같은 명령 패턴이 반복되면
 * 그것이 다음에 만들 전용 툴 후보다 — 탈출로 통행량이 도로 계획이다.
 */

/**
 * 조회 화이트리스트. 기준 두 가지:
 *   1) 시스템 상태를 읽기만 한다 (쓰기 플래그가 있는 명령은 조회형 서브커맨드만 허용)
 *   2) 임의 파일 경로를 인자로 받지 않는다 — cat/head/ls 는 여기 없다.
 *      파일 읽기는 정책 검사가 있는 read_file 로만 간다. 여기로 우회하면 deny 가 뚫린다.
 */
const QUERY_ALLOWLIST: RegExp[] = [
  /^networksetup -get\S+/,
  /^networksetup -list\S*/,
  /^system_profiler \S+$/,
  /^sw_vers\b/,
  /^uname\b/,
  /^uptime$/,
  /^date\b/,
  /^whoami$/,
  /^id$/,
  /^pmset -g\b/,
  /^df -h?\b/,
  /^sysctl -n \S+$/,
  /^ipconfig getifaddr \S+$/,
  /^scutil --nwi$/,
  /^scutil --get \S+$/,
  /^defaults read \S+ ?\S*$/,
  /^mdfind -count \S+/,
  /^osascript -e 'tell application "System Events" to get \S+/,
];

const OUTPUT_CAP = 8_000;

function cap(s: string): string {
  return s.length > OUTPUT_CAP ? s.slice(0, OUTPUT_CAP) + `\n… (${s.length} 바이트 중 앞부분만)` : s;
}

async function runViaShell(command: string, timeoutMs: number): Promise<string> {
  const { stdout, stderr } = await exec("/bin/zsh", ["-c", command], {
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n--- stderr ---\n");
  return cap(out) || "(출력 없음)";
}

export const runSystemQuery: ToolSpec = {
  name: "run_system_query",
  description:
    "시스템 정보 조회 명령을 실행한다 (네트워크·배터리·디스크·OS 버전 등). " +
    "허용된 조회 명령만 통과하며 아무것도 바꾸지 않는다. " +
    "파일 내용을 읽으려면 이 툴이 아니라 read_file 을 사용하라.",
  action: "read",
  reversibility: "R0",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description:
          "실행할 조회 명령 한 줄. 예: networksetup -getairportnetwork en0, pmset -g batt, df -h",
      },
    },
    required: ["command"],
  },
  async run(args) {
    const command = String(args["command"] ?? "").trim();
    if (!QUERY_ALLOWLIST.some((re) => re.test(command))) {
      return (
        `조회 화이트리스트에 없는 명령입니다: ${command}\n` +
        `시스템을 변경하거나 파일을 읽는 명령이면 run_command(승인 필요) 또는 read_file 을 사용하십시오.`
      );
    }
    return runViaShell(command, 15_000);
  },
};

export const runCommand: ToolSpec = {
  name: "run_command",
  description:
    "임의의 터미널 명령을 실행한다. 전용 툴로 해결되지 않을 때만 쓰는 최후 수단이다. " +
    "파일 생성·수정·이동·삭제는 반드시 전용 툴(write_file 등)을 사용하라 — " +
    "이 툴로 바꾼 것은 onmac 이 되돌려 줄 수 없다.",
  action: "shell",
  // 임의 명령의 효과는 분류할 수 없으므로 최악을 가정한다.
  // R3 = 어떤 실적으로도 위임 불가, 세션 승인(a) 불가, 매번 명령 전문을 보고 승인.
  reversibility: "R3",
  describe: (a) => ({
    title: "터미널 명령을 실행할게요",
    changes: `실행: ${String(a["command"] ?? "")}`,
    loses: "명령에 따라 다릅니다 — onmac 이 효과를 미리 알 수 없습니다",
    recover: "쉘 명령이 바꾼 것은 onmac undo 로 되돌릴 수 없습니다",
  }),
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "실행할 명령 한 줄" },
      timeoutSec: { type: "number", description: "제한 시간(초), 기본 30" },
    },
    required: ["command"],
  },
  async run(args) {
    const command = String(args["command"] ?? "").trim();
    if (!command) throw new Error("명령이 비어 있습니다.");
    const timeout = Math.min(300, Math.max(1, Number(args["timeoutSec"] ?? 30))) * 1000;
    return runViaShell(command, timeout);
  },
};

export const shellTools = [runSystemQuery, runCommand];
