import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolSpec } from "../types.ts";

const exec = promisify(execFile);

async function osa(script: string): Promise<string> {
  const { stdout } = await exec("osascript", ["-e", script], { timeout: 20_000 });
  return stdout.trim();
}

/**
 * macOS 설정 창을 여는 URL 스킴 목록.
 *
 * 등급 S2 — 창을 "여는" 것까지만 한다. 창 안의 버튼을 누르는 것은 UI 스크립팅(S3)이라
 * Accessibility 권한이 필요하고 OS 버전마다 깨지므로 여기 넣지 않는다.
 */
const SETTINGS_PANES: Record<string, string> = {
  display: "com.apple.Displays-Settings.extension",
  sound: "com.apple.Sound-Settings.extension",
  network: "com.apple.Network-Settings.extension",
  bluetooth: "com.apple.BluetoothSettings",
  keyboard: "com.apple.Keyboard-Settings.extension",
  privacy: "com.apple.settings.PrivacySecurity.extension",
  battery: "com.apple.Battery-Settings.extension",
  general: "com.apple.systempreferences.GeneralSettings",
  appearance: "com.apple.Appearance-Settings.extension",
  notifications: "com.apple.Notifications-Settings.extension",
};

export const openSettingsPane: ToolSpec = {
  name: "open_settings_pane",
  description: `macOS 시스템 설정의 특정 패널을 연다. 사용 가능: ${Object.keys(SETTINGS_PANES).join(", ")}`,
  action: "settings",
  reversibility: "R0", // 창을 여는 것뿐이라 되돌릴 게 없다
  describe: (a) => ({
    title: `시스템 설정의 ${String(a["pane"] ?? "")} 화면을 열게요`,
    changes: "설정 창이 열릴 뿐, 아무 값도 바뀌지 않습니다",
    loses: "없음",
    recover: "창을 닫으면 끝입니다",
  }),
  parameters: {
    type: "object",
    properties: { pane: { type: "string", description: "패널 이름", enum: Object.keys(SETTINGS_PANES) } },
    required: ["pane"],
  },
  async run(args) {
    const pane = String(args["pane"]);
    const id = SETTINGS_PANES[pane];
    if (!id) throw new Error(`알 수 없는 패널: ${pane}. 가능: ${Object.keys(SETTINGS_PANES).join(", ")}`);
    await exec("open", [`x-apple.systempreferences:${id}`]);
    return `시스템 설정 > ${pane} 패널을 열었습니다.`;
  },
};

export const getSystemState: ToolSpec = {
  name: "get_system_state",
  description: "다크모드, 볼륨, 디스플레이 미러링 등 현재 시스템 상태를 조회한다.",
  action: "settings",
  reversibility: "R0",
  parameters: { type: "object", properties: {}, required: [] },
  async run() {
    const [dark, volume, displays] = await Promise.all([
      osa('tell application "System Events" to tell appearance preferences to get dark mode'),
      osa("output volume of (get volume settings)"),
      exec("system_profiler", ["SPDisplaysDataType"]).then(({ stdout }) =>
        stdout.split("\n").filter((l) => /Resolution|Mirror|Display Type/.test(l)).map((l) => l.trim()).join(" | "),
      ),
    ]);
    return `다크모드: ${dark}\n볼륨: ${volume}\n디스플레이: ${displays}`;
  },
};

export const setDarkMode: ToolSpec = {
  name: "set_dark_mode",
  description: "다크모드를 켜거나 끈다.",
  action: "settings",
  reversibility: "R2", // 이전 값을 기록해두면 역연산이 자명하다
  describe: (a) => ({
    title: `화면을 ${a["enabled"] === true ? "다크" : "라이트"} 모드로 바꿀게요`,
    changes: "시스템 외관 설정 하나가 바뀝니다",
    loses: "없음",
    recover: "이전 값을 기억해 두므로 \"되돌려줘\" 로 원래대로 돌아갑니다",
  }),
  parameters: {
    type: "object",
    properties: { enabled: { type: "boolean", description: "true=다크모드 켜기" } },
    required: ["enabled"],
  },
  async run(args, ctx) {
    const want = args["enabled"] === true;
    const before = await osa('tell application "System Events" to tell appearance preferences to get dark mode');
    await ctx.tx.record({ kind: "settingChange", key: "darkMode", before, after: String(want) });
    await osa(`tell application "System Events" to tell appearance preferences to set dark mode to ${want}`);
    return `다크모드: ${before} → ${want}`;
  },
};

export const setVolume: ToolSpec = {
  name: "set_volume",
  description: "출력 볼륨을 0~100 사이로 설정한다.",
  action: "settings",
  reversibility: "R2",
  describe: (a) => ({
    title: `볼륨을 ${Number(a["level"])} 로 맞출게요`,
    changes: "출력 볼륨 하나가 바뀝니다",
    loses: "없음",
    recover: "이전 볼륨을 기억해 두므로 \"되돌려줘\" 로 원래대로 돌아갑니다",
  }),
  parameters: {
    type: "object",
    properties: { level: { type: "number", description: "0~100" } },
    required: ["level"],
  },
  async run(args, ctx) {
    const level = Math.max(0, Math.min(100, Number(args["level"])));
    const before = await osa("output volume of (get volume settings)");
    await ctx.tx.record({ kind: "settingChange", key: "volume", before, after: String(level) });
    await osa(`set volume output volume ${level}`);
    return `볼륨: ${before} → ${level}`;
  },
};

export const listShortcuts: ToolSpec = {
  name: "list_shortcuts",
  description:
    "사용자가 단축어(Shortcuts) 앱에 만들어둔 자동화 목록을 조회한다. " +
    "UI 를 직접 클릭하는 대신 단축어를 호출하는 편이 훨씬 안정적이다.",
  action: "app_control",
  reversibility: "R0",
  parameters: { type: "object", properties: {}, required: [] },
  async run() {
    const { stdout } = await exec("shortcuts", ["list"]);
    return stdout.trim() || "등록된 단축어가 없습니다.";
  },
};

export const runShortcut: ToolSpec = {
  name: "run_shortcut",
  description:
    "단축어를 실행한다. 단축어가 무슨 일을 하는지는 onmac 이 알 수 없으므로 " +
    "되돌릴 수 없는 작업(R3)으로 취급하며 매번 승인을 받는다.",
  action: "app_control",
  reversibility: "R3",
  describe: (a) => ({
    title: `단축어 "${String(a["name"] ?? "")}" 을(를) 실행할게요`,
    changes: "이 단축어가 무슨 일을 하는지 onmac 은 알 수 없습니다",
    loses: "단축어 내용에 따라 다릅니다 — onmac 이 보장할 수 없습니다",
    recover: "되돌릴 수 없습니다. 단축어가 한 일은 onmac 의 undo 밖입니다",
  }),
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "실행할 단축어 이름" },
      input: { type: "string", description: "단축어에 전달할 입력 (선택)" },
    },
    required: ["name"],
  },
  async run(args) {
    const name = String(args["name"]);
    const input = args["input"];
    const argv = ["run", name, ...(typeof input === "string" ? ["-i", input] : [])];
    const { stdout } = await exec("shortcuts", argv, { timeout: 120_000 });
    return `단축어 '${name}' 실행 완료.\n${stdout.trim()}`;
  },
};

/** settingChange op 의 역연산. tx 엔진에 주입된다. */
export async function restoreSetting(key: string, value: string): Promise<void> {
  switch (key) {
    case "darkMode":
      await osa(`tell application "System Events" to tell appearance preferences to set dark mode to ${value === "true"}`);
      return;
    case "volume":
      await osa(`set volume output volume ${Number(value)}`);
      return;
    default:
      throw new Error(`복원 방법이 정의되지 않은 설정: ${key}`);
  }
}

export const macosTools = [
  openSettingsPane,
  getSystemState,
  setDarkMode,
  setVolume,
  listShortcuts,
  runShortcut,
];
