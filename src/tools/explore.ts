import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdtemp } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import type { ToolSpec } from "../types.ts";
import type { PolicyEngine } from "../core/policy.ts";
import { expand } from "../core/policy.ts";

const exec = promisify(execFile);
const OUTPUT_CAP = 12_000;

/**
 * 탐색 층 — "모델이 스스로 알아내게" 하는 자리.
 *
 * 설계 전환:
 *   기존에는 조회할 수 있는 명령을 화이트리스트로 열거했다. 케이스마다 툴을
 *   파야 하니 커버리지가 영원히 부족했다 ("와이파이 뭐야?" 가 막혔던 이유).
 *
 *   이제는 반대로 한다 — **아무 읽기 명령이나 실행하되, 정책 경로는 OS 가 막는다.**
 *   macOS 의 sandbox-exec 로 seatbelt 프로필을 씌우면 deny 경로에 대한
 *   file-read* 가 커널 레벨에서 거부된다. 우리 코드가 뚫려도 뚫리지 않는다.
 *   (실측: sandbox-exec 안에서 `ls ~/.ssh` → Operation not permitted)
 *
 * 왜 쓰기는 여기 없나:
 *   쓰기를 셸에 맡기면 "무엇이 바뀌었는지" 를 알 수 없어 결과-언어 카드·정밀
 *   undo·신뢰 승급이 전부 무너진다. 쓰기는 apply(스냅샷 보호) 또는 전용 툴로 간다.
 */

/** 쓰기·삭제·전송으로 읽히는 명령은 explore 에서 거른다 (샌드박스는 읽기만 막을 뿐이므로). */
const WRITE_HINTS =
  /\b(rm|rmdir|mv|cp|dd|mkdir|touch|ln|chmod|chown|kill|killall|shutdown|reboot|diskutil|tmutil|defaults\s+write|launchctl|installer|softwareupdate|pip|npm|brew|git\s+(push|commit|checkout|reset|clean)|curl|wget|nc|ssh|scp|osascript)\b/;
const REDIRECT = /(^|[^>])>{1,2}[^>]|\btee\b/;

/**
 * seatbelt 프로필 생성.
 *
 * (allow default) 로 시작해 필요한 것만 빼는 방식이다. 완전 격리가 아니라
 * "정책이 금지한 것을 커널이 재확인" 하는 2차 방어선이기 때문이다.
 * 1차 방어선은 여전히 정책 엔진이고, 이건 셸이라는 넓은 표면에 씌우는 그물이다.
 */
function buildProfile(policy: PolicyEngine): string {
  const lines = [
    "(version 1)",
    "(allow default)",
    "; 쓰기 전면 금지 — explore 는 읽기 전용이다",
    '(deny file-write* (subpath "/"))',
    '(allow file-write* (subpath "/dev"))',
    '(allow file-write* (subpath "/private/tmp"))',
    '(allow file-write* (subpath "/private/var/folders"))',
    "; 정책이 보호하는 경로는 커널이 읽기를 거부한다",
  ];
  /**
   * seatbelt 는 심볼릭 링크를 푼 **실제 경로**로 매칭한다.
   * macOS 에서 /tmp → /private/tmp, /var → /private/var 이므로 원문만 넣으면
   * 규칙이 조용히 빗나간다 (실측으로 확인한 우회 경로다). 양쪽 다 넣는다.
   */
  const denySubpath = (dir: string) => {
    const set = new Set([dir]);
    try {
      set.add(realpathSync(dir));
    } catch {
      /* 존재하지 않는 경로는 원문만 */
    }
    for (const d of set) lines.push(`(deny file-read* (subpath "${d}"))`);
  };

  for (const pattern of policy.denyGlobsDisplay) {
    // glob 을 seatbelt 가 이해하는 형태로 낮춘다:
    //   ~/.ssh/**      → subpath  ~/.ssh
    //   **/.env        → regex    이름이 .env 로 끝나는 모든 경로
    const p = pattern.replace(/^~/, homedir());
    if (p.startsWith("/") && !p.includes("*")) {
      denySubpath(p);
    } else if (/^\/.*\/\*\*$/.test(p)) {
      denySubpath(p.replace(/\/\*\*$/, ""));
    } else {
      const base = p.split("/").pop() ?? p;
      const re = base.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
      lines.push(`(deny file-read* (regex #"/${re}$"))`);
    }
  }
  return lines.join("\n");
}

/**
 * 알려진 거짓말 교정.
 *
 * 어떤 CLI 는 "정보를 줄 수 없음" 을 "그런 상태가 아님" 으로 보고한다.
 * 모델은 그 출력을 믿을 수밖에 없고, 결과적으로 사용자에게 틀린 사실을 말한다.
 * (실측: Wi-Fi 핫스팟에 정상 연결된 상태인데 networksetup 이
 *  "not associated with an AirPort network" 를 반환 → 모델이 "연결 안 됨" 이라고 답함)
 *
 * 그래서 우리가 아는 함정은 출력에 사실을 덧붙여 모델이 오판하지 않게 한다.
 */
async function annotate(command: string, output: string): Promise<string> {
  if (/networksetup\s+-getairportnetwork|airport\s+-I|ipconfig\s+getsummary/.test(command)) {
    const hidden = /not associated|<redacted>/i.test(output);
    if (hidden) {
      const iface = /-getairportnetwork\s+(\w+)/.exec(command)?.[1] ?? "en0";
      const [ip, route] = await Promise.all([
        exec("ipconfig", ["getifaddr", iface]).then(({ stdout }) => stdout.trim()).catch(() => ""),
        exec("route", ["-n", "get", "default"]).then(({ stdout }) => stdout).catch(() => ""),
      ]);
      const routed = new RegExp(`interface:\\s*${iface}`).test(route);
      if (ip || routed) {
        return (
          `${output}\n\n[onmac 주석] 위 출력은 "연결 안 됨" 을 뜻하지 않습니다.\n` +
          `${iface} 는 실제로 연결되어 있습니다 — IP ${ip || "(확인 실패)"}` +
          `${routed ? ", 기본 경로가 이 인터페이스를 통과합니다" : ""}.\n` +
          `macOS 15+ 는 Wi-Fi 이름(SSID)을 위치 정보로 취급해, 위치 권한이 없는 CLI 에는 가립니다.\n` +
          `연결 여부는 위 IP·경로로 판단하고, 이름은 "가려져 있다" 고 전하십시오.\n` +
          `이름까지 필요하면: 시스템 설정 > 개인정보 보호 > 위치 서비스에서 터미널 앱을 허용하거나, ` +
          `단축어 앱의 "네트워크 세부사항 가져오기" 를 run_shortcut 으로 실행하십시오.`
        );
      }
    }
  }
  return output;
}

export function buildExploreTools(policy: PolicyEngine): ToolSpec[] {
  const explore: ToolSpec = {
    name: "explore",
    description:
      "이 Mac 을 조사한다. 아무 읽기 명령이나 셸로 실행할 수 있다 — " +
      "ls, cat, grep, find, wc, head, sw_vers, pmset, networksetup, system_profiler, ipconfig, " +
      "defaults read, mdfind, du, df, ps 등. 파이프·리다이렉트 없는 조합도 가능. " +
      "모르는 것이 있으면 사용자에게 묻기 전에 이 도구로 직접 확인하라. " +
      "아무것도 바꾸지 않으며 승인 없이 실행된다. 파일을 바꾸려면 write_file/move_file/apply 를 쓰라.",
    action: "read",
    reversibility: "R0",
    label: (a) => String(a["command"] ?? "").slice(0, 60),
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "실행할 읽기 전용 셸 명령 한 줄. 예: networksetup -getairportnetwork en0" },
        why: { type: "string", description: "무엇을 알아내려는지 한 줄 (사용자에게 표시됨)" },
      },
      required: ["command"],
    },
    async run(args) {
      const command = String(args["command"] ?? "").trim();
      if (!command) {
        // 작은 모델이 인자를 비운 채 반복 호출하는 실패 모드가 실측됐다.
        // 에러가 아니라 "어떻게 고쳐 부르는지" 를 돌려줘야 한 턴에 자기교정한다.
        return (
          `command 인자가 비어 있습니다. 실행할 셸 명령을 문자열로 넣어 다시 호출하십시오.\n` +
          `예: {"name":"explore","arguments":{"command":"networksetup -getairportnetwork en0"}}\n` +
          `예: {"name":"explore","arguments":{"command":"pmset -g batt"}}`
        );
      }

      if (WRITE_HINTS.test(command) || REDIRECT.test(command)) {
        return (
          `explore 는 읽기 전용입니다. 이 명령은 시스템을 바꿀 수 있어 거부되었습니다: ${command}\n` +
          `파일 변경은 write_file/move_file/delete_file 을, 그 외 변경은 apply 를 사용하십시오 (승인 필요).`
        );
      }

      const dir = await mkdtemp(join(tmpdir(), "onmac-sb-"));
      const profile = join(dir, "explore.sb");
      await writeFile(profile, buildProfile(policy));

      try {
        const { stdout, stderr } = await exec(
          "/usr/bin/sandbox-exec",
          ["-f", profile, "/bin/zsh", "-c", command],
          { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
        );
        const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
        const capped = out.length > OUTPUT_CAP ? out.slice(0, OUTPUT_CAP) + "\n… (출력 일부 생략)" : out;
        return (await annotate(command, capped)) || "(출력 없음)";
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        const text = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").trim();
        if (/Operation not permitted/.test(text)) {
          return (
            `일부 경로가 정책으로 보호되어 접근이 거부되었습니다.\n${text.slice(0, 600)}\n` +
            `보호 경로는 어떤 방법으로도 읽을 수 없습니다. 다른 방법을 시도하거나 사용자에게 알리십시오.`
          );
        }
        return await annotate(command, `명령 실패:\n${text.slice(0, 1200)}`);
      }
    },
  };

  const readFileTool: ToolSpec = {
    name: "read_file",
    description:
      "파일 하나의 내용을 읽는다. 긴 파일도 안전하게 잘라서 준다. " +
      "여러 파일을 훑거나 검색할 때는 explore 를 쓰라.",
    action: "read",
    reversibility: "R0",
    targetOf: (a) => a["path"] as string,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "읽을 파일 절대경로" },
        maxBytes: { type: "number", description: "최대 바이트 (기본 200000)" },
      },
      required: ["path"],
    },
    async run(args) {
      const { readFile: rf, stat } = await import("node:fs/promises");
      const p = expand(String(args["path"] ?? ""));
      const limit = Number(args["maxBytes"] ?? 200_000);
      const s = await stat(p);
      const text = (await rf(p)).subarray(0, limit).toString("utf8");
      return s.size > limit ? `${text}\n\n… (총 ${s.size} 바이트 중 앞 ${limit})` : text;
    },
  };

  return [explore, readFileTool];
}
