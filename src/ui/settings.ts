import { emitKeypressEvents } from "node:readline";
import { writeFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { OnmacConfig } from "../core/config.ts";
import { ANSI, bold, cyan, dim, gray, green, isTTY, red, yellow } from "./theme.ts";

/**
 * 보안 설정을 켜고 끄는 대화형 화면.
 *
 * 설계 원칙 하나: 기본값은 항상 "안전한 쪽"이고, 일부 항목은 아예 끌 수 없다.
 * 삭제 확인이나 UI 스크립팅 차단처럼 끄는 순간 다른 방어가 무의미해지는 것들은
 * 잠금(locked) 으로 두고 체크박스 대신 자물쇠를 보여준다 —
 * 있는데 못 끄는 것과, 애초에 선택지가 없는 것은 사용자에게 다르게 읽힌다.
 */

type ItemKind = "denyPath" | "allowRoot" | "askAction" | "rollback";

interface Item {
  kind: ItemKind;
  key: string;
  label: string;
  note: string;
  checked: boolean;
  /** 끌 수 없는 항목. 왜 못 끄는지를 note 에 적는다. */
  locked?: boolean;
  /** 켜면 위험이 늘어나는 항목 (예: sudo 필요) */
  caution?: boolean;
}

interface Group {
  title: string;
  hint: string;
  items: Item[];
}

const DENY_PRESETS: Array<[string, string, string]> = [
  ["~/.ssh/**", "SSH 키", "서버 접속 키. 유출 시 피해가 가장 큼"],
  ["**/.env", "환경변수 파일", "API 키·DB 비밀번호가 들어 있는 곳"],
  ["**/.env.*", "환경변수 파일 변형", ".env.local, .env.production 등"],
  ["**/*.pem", "인증서 · 개인키", "TLS 개인키, 클라우드 접속 키"],
  ["**/*.key", "키 파일", "확장자만으로 식별되는 키"],
  ["**/id_rsa*", "SSH 개인키 파일명", "경로가 아니라 파일명으로 한 번 더"],
  ["**/credentials*", "자격증명 파일", "aws/gcloud 등이 쓰는 이름"],
  ["~/Library/Keychains/**", "키체인", "macOS 가 비밀번호를 보관하는 곳"],
  ["~/.aws/**", "AWS 설정", "액세스 키가 평문으로 있는 경우가 많음"],
  ["~/.config/gh/**", "GitHub CLI 토큰", "리포 쓰기 권한 토큰"],
  ["**/*.kdbx", "비밀번호 관리자 DB", "KeePass 계열 저장소"],
  ["~/certs/**", "사내 인증서", "회사 프록시·VPN 인증서"],
];

const ROOT_PRESETS: Array<[string, string, string]> = [
  ["~/Desktop", "바탕화면", "정리 작업의 주 대상"],
  ["~/Downloads", "다운로드", "PDF·문서 분석의 주 대상"],
  ["~/Documents", "문서", "장기 보관 문서"],
  ["~/ObsidianVaults", "Obsidian 볼트", "노트 읽기·쓰기"],
  [process.cwd().replace(homedir(), "~"), "현재 디렉토리", "이 자리에서만 쓰고 싶을 때"],
];

const ASK_PRESETS: Array<[string, string, string, boolean]> = [
  // key, label, note, locked
  ["write", "파일 쓰기 전 승인", "끄면 모델이 예고 없이 파일을 덮어쓴다", false],
  ["move", "파일 이동 전 승인", "끄면 파일이 말없이 재배치된다", false],
  ["app_control", "앱 제어 전 승인", "AppleScript 로 캘린더·메모 등을 조작", false],
  ["settings", "시스템 설정 변경 전 승인", "다크모드·볼륨 등", false],
  ["shell", "셸 명령 전 승인", "끄는 것을 권하지 않는다", false],
  ["delete", "삭제는 매번 승인 (끌 수 없음)", "세션 전체 승인으로도 건너뛸 수 없다. 파일을 잃는 가장 흔한 경로라서 잠가 두었다", true],
  ["ui_control", "화면 클릭 자동화 차단 (끌 수 없음)", "Accessibility 권한이 필요하고 macOS 버전마다 깨진다. 단축어를 쓰는 편이 안전하다", true],
  ["network", "네트워크 차단 (구현 자체가 없음)", "HTTP 클라이언트가 코드에 존재하지 않는다. 설정으로 켤 수 있는 것이 아니다", true],
];

function buildGroups(cfg: OnmacConfig): Group[] {
  const deny = new Set(cfg.policy.roots.deny);
  const allow = new Set(cfg.policy.roots.allow);

  return [
    {
      title: "보호할 것 — 절대 읽히면 안 되는 경로",
      hint: "체크된 항목은 허용 루트 안에 있어도 차단된다 (차단이 허용을 이긴다)",
      items: DENY_PRESETS.map(([key, label, note]) => ({
        kind: "denyPath" as const,
        key,
        label,
        note,
        checked: deny.has(key),
      })),
    },
    {
      title: "열어줄 것 — 에이전트가 접근할 수 있는 범위",
      hint: "체크하지 않은 경로는 읽지도 못한다. 좁게 시작해서 필요할 때 넓히는 편이 안전하다",
      items: ROOT_PRESETS.map(([key, label, note]) => ({
        kind: "allowRoot" as const,
        key,
        label,
        note,
        checked: allow.has(key),
      })),
    },
    {
      title: "물어볼 것 — 실행 전 승인이 필요한 행위",
      hint: "체크를 풀면 그 행위는 승인 없이 즉시 실행된다",
      items: ASK_PRESETS.map(([key, label, note, locked]) => ({
        kind: "askAction" as const,
        key,
        label,
        note,
        locked,
        checked: locked ? true : cfg.policy.actions[key] !== "allow",
      })),
    },
    {
      title: "되돌리기",
      hint: "저널은 끌 수 없다 — 되돌릴 수 없는 에이전트는 만들지 않는다",
      items: [
        {
          kind: "rollback",
          key: "tier1Journal",
          label: "변경 저널 + 스냅샷 (끌 수 없음)",
          note: "onmac undo 의 근거. 용량을 거의 쓰지 않는다",
          checked: true,
          locked: true,
        },
        {
          kind: "rollback",
          key: "tier2ApfsSnapshot",
          label: "대량 작업 전 APFS 볼륨 스냅샷",
          note: "sudo 권한이 필요하다. 파일 100개 이상 바뀔 때 자동 생성",
          checked: cfg.rollback.tier2ApfsSnapshot,
          caution: true,
        },
      ],
    },
  ];
}

/** 설정 파일 본문을 새로 만든다. 주석을 살리려고 파서 출력 대신 직접 조립한다. */
function renderToml(cfg: OnmacConfig, groups: Group[]): string {
  const picked = (kind: ItemKind) =>
    groups.flatMap((g) => g.items).filter((i) => i.kind === kind && i.checked);

  const deny = picked("denyPath").map((i) => i.key);
  const allow = picked("allowRoot").map((i) => i.key);
  const actions: Record<string, string> = {
    read: "allow",
    list: "allow",
    delete: "ask_always",
    ui_control: "deny",
  };
  for (const [key] of ASK_PRESETS) {
    if (key === "delete" || key === "ui_control" || key === "network") continue;
    const item = groups.flatMap((g) => g.items).find((i) => i.kind === "askAction" && i.key === key);
    actions[key] = item?.checked ? "ask" : "allow";
  }

  const tier2 = groups
    .flatMap((g) => g.items)
    .find((i) => i.kind === "rollback" && i.key === "tier2ApfsSnapshot")?.checked;

  const list = (xs: string[]) => (xs.length ? "\n" + xs.map((x) => `  "${x}",`).join("\n") + "\n" : "");

  return `# onmac 설정 — onmac settings 로 생성됨
# 직접 편집해도 되지만, 다시 onmac settings 를 실행하면 이 형식으로 덮어쓴다.

[llm]
backend = "${cfg.llm.backend}"
maxTurns = ${cfg.llm.maxTurns}
maxKvSize = ${cfg.llm.maxKvSize}
thinking = ${cfg.llm.thinking ? "true" : "false"}

[llm.mlx]
modelPath = "${cfg.llm.mlx.modelPath}"
python = "${cfg.llm.mlx.python}"

[llm.llamacpp]
modelPath = "${cfg.llm.llamacpp.modelPath}"${cfg.llm.llamacpp.mmprojPath ? `\nmmprojPath = "${cfg.llm.llamacpp.mmprojPath}"` : ""}

[roots]
# 에이전트가 접근할 수 있는 범위
allow = [${list(allow)}]
# 차단은 허용을 항상 이긴다. allow 안에 있어도 여기 걸리면 못 읽는다.
deny = [${list(deny)}]

[actions]
read        = "allow"
list        = "allow"
write       = "${actions["write"]}"
move        = "${actions["move"]}"
delete      = "ask_always"   # 잠김 — 세션 승인으로도 건너뛸 수 없다
shell       = "${actions["shell"]}"
app_control = "${actions["app_control"]}"
settings    = "${actions["settings"]}"
ui_control  = "deny"         # 잠김 — Accessibility 기반 화면 클릭은 비활성
# network 항목은 없다. 네트워크 클라이언트가 구현되어 있지 않다.

[trust]
promoteAfter = ${cfg.trust.promoteAfter}

[limits]
maxFileMb = ${cfg.policy.limits.maxFileMb}
maxFilesPerCall = ${cfg.policy.limits.maxFilesPerCall}

[rollback]
tier1Journal = true          # 잠김
tier2ApfsSnapshot = ${tier2 ? "true" : "false"}
tier2ThresholdFiles = ${cfg.rollback.tier2ThresholdFiles}
trashRetentionDays = ${cfg.rollback.trashRetentionDays}
`;
}

interface Row {
  group: number;
  item?: Item;
}

/** 그룹 제목과 항목을 한 줄씩 펼친 목록. 커서는 항목 행에만 멈춘다. */
function flatten(groups: Group[]): Row[] {
  const rows: Row[] = [];
  groups.forEach((g, gi) => {
    rows.push({ group: gi });
    g.items.forEach((item) => rows.push({ group: gi, item }));
  });
  return rows;
}

export async function runSettings(cfg: OnmacConfig): Promise<boolean> {
  if (!isTTY) {
    process.stderr.write("설정 화면은 터미널에서만 열 수 있습니다.\n");
    return false;
  }

  const groups = buildGroups(cfg);
  const rows = flatten(groups);
  const selectable = rows.map((r, i) => (r.item ? i : -1)).filter((i) => i >= 0);
  let cursor = selectable[0]!;
  let dirty = false;
  let lastHeight = 0;

  const render = () => {
    const out: string[] = [];
    out.push("");
    out.push(`  ${bold("onmac 보안 설정")}   ${dim(cfg.configPath.replace(homedir(), "~"))}`);
    out.push(
      `  ${dim("↑↓ 이동   space 켜기/끄기   enter 저장   q 취소")}`,
    );
    out.push("");

    rows.forEach((row, i) => {
      const g = groups[row.group]!;
      if (!row.item) {
        out.push(`  ${bold(g.title)}`);
        out.push(`  ${dim(g.hint)}`);
        return;
      }
      const it = row.item;
      const here = i === cursor;
      const box = it.locked
        ? gray("[")+ gray("🔒") + gray("]")
        : it.checked
          ? green("[×]")
          : gray("[ ]");
      const name = it.locked ? gray(it.label) : it.checked ? it.label : dim(it.label);
      const caution = it.caution && it.checked ? ` ${yellow("sudo 필요")}` : "";
      const arrow = here ? cyan("›") : " ";
      out.push(`  ${arrow} ${box} ${name}${caution}`);
      if (here) out.push(`      ${dim(it.note)}   ${gray(it.key)}`);
      else out.push("");
    });

    out.push("");
    const allowCount = groups[1]!.items.filter((i) => i.checked).length;
    const denyCount = groups[0]!.items.filter((i) => i.checked).length;
    if (allowCount === 0) {
      out.push(`  ${yellow("⚠")}  허용 경로가 하나도 없습니다. 이대로 저장하면 아무 작업도 하지 못합니다.`);
    } else {
      out.push(`  ${dim(`허용 ${allowCount}곳 · 차단 패턴 ${denyCount}개`)}${dirty ? "  " + yellow("저장 안 됨") : ""}`);
    }
    out.push("");

    const text = out.join("\n");
    // 이전 프레임 높이만큼 올라가서 덮어쓴다. 화면 전체를 지우면 위 대화 기록이 사라진다.
    process.stdout.write((lastHeight ? ANSI.up(lastHeight) : "") + text.split("\n").map((l) => `\x1b[2K${l}`).join("\n") + "\n");
    lastHeight = text.split("\n").length + 1;
  };

  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write(ANSI.hideCursor);
  render();

  const saved = await new Promise<boolean>((resolve) => {
    const onKey = (_s: string, k: { name?: string; ctrl?: boolean; sequence?: string }) => {
      const move = (dir: 1 | -1) => {
        const idx = selectable.indexOf(cursor);
        cursor = selectable[(idx + dir + selectable.length) % selectable.length]!;
      };
      if (k.name === "up" || k.name === "k") move(-1);
      else if (k.name === "down" || k.name === "j") move(1);
      else if (k.name === "space") {
        const it = rows[cursor]?.item;
        if (it && !it.locked) {
          it.checked = !it.checked;
          dirty = true;
        }
      } else if (k.name === "return") {
        cleanup();
        return resolve(true);
      } else if (k.name === "q" || k.name === "escape" || (k.ctrl && k.name === "c")) {
        cleanup();
        return resolve(false);
      } else return;
      render();
    };

    const cleanup = () => {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write(ANSI.showCursor);
    };

    process.stdin.on("keypress", onKey);
  });

  if (!saved) {
    process.stdout.write(`  ${dim("취소했습니다. 설정을 바꾸지 않았습니다.")}\n\n`);
    return false;
  }

  const allowCount = groups[1]!.items.filter((i) => i.checked).length;
  if (allowCount === 0) {
    process.stdout.write(`  ${red("✖")} 허용 경로가 없어 저장하지 않았습니다.\n\n`);
    return false;
  }

  // 덮어쓰기 전 원본을 남긴다. 정책 파일은 되돌릴 수 있어야 한다.
  try {
    const prev = await readFile(cfg.configPath, "utf8");
    await writeFile(`${cfg.configPath}.bak`, prev);
  } catch {
    /* 원본이 없으면 백업할 것도 없다 */
  }
  await writeFile(cfg.configPath, renderToml(cfg, groups));
  process.stdout.write(
    `  ${green("✔")} 저장: ${cfg.configPath.replace(homedir(), "~")}  ${dim("(이전 버전은 .bak 로 보관)")}\n\n`,
  );
  return true;
}
