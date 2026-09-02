import { bold, dim, gray, gradient, green, useColor } from "./theme.ts";

const LOGO = String.raw`
  ▄▄▄▄▄   ▄▄   ▄ ▄▄   ▄▄  ▄▄▄▄   ▄▄▄▄
 ██   ██ ███  ██ ███ ███ ██  ██ ██
 ██   ██ ██ █ ██ ██ █ ██ ██████ ██
 ██   ██ ██  ███ ██   ██ ██  ██ ██
  ▀███▀  ▀▀   ▀▀ ▀▀   ▀▀ ▀▀  ▀▀  ▀▀▀▀
`;

/** 좁은 터미널이나 색 없는 환경에서 쓰는 대체 배너. */
const COMPACT = "  onmac";

export interface BannerInfo {
  version: string;
  backend: string;
  model: string;
  toolCount: number;
  configPath: string;
  allowRoots: number;
}

export function renderBanner(info: BannerInfo): string {
  const width = process.stdout.columns ?? 80;
  const out: string[] = [""];

  if (width >= 46 && useColor) {
    // 청록 → 보라 그라데이션. 24비트 미지원이면 theme 가 단색으로 떨어뜨린다.
    for (const line of LOGO.split("\n").slice(1, -1)) {
      out.push(gradient(line, [56, 189, 248], [167, 139, 250]));
    }
  } else {
    out.push(bold(COMPACT));
  }

  out.push(
    `  ${dim("승인 없이는 아무것도 하지 않는, 네트워크 없는 로컬 에이전트")}  ${gray("v" + info.version)}`,
  );
  out.push("");
  out.push(
    [
      `  ${gray("모델")} ${info.model}`,
      `  ${gray("백엔드")} ${info.backend}   ${gray("툴")} ${info.toolCount}개   ${gray("허용 루트")} ${info.allowRoots}곳`,
      `  ${gray("설정")} ${info.configPath}`,
      `  ${green("●")} ${dim("네트워크 클라이언트 없음 — 오프라인 동작")}`,
    ].join("\n"),
  );
  out.push("");
  out.push(
    `  ${dim("/help 도움말   /settings 보안설정   /tools 툴 목록   /undo 되돌리기")}`,
  );
  out.push("");
  return out.join("\n");
}

export const HELP = `
  ${bold("대화")}
    그냥 한국어로 시키면 된다. 파일을 바꾸는 작업은 실행 전에 승인을 묻는다.

  ${bold("세션 명령")}
    /help          이 도움말
    /tools         사용 가능한 툴과 각각의 위험 등급
    /policy        현재 허용/차단 경로
    /settings      보안 설정 화면 (방향키 + 스페이스)
    /stats         마지막 추론 실측치
    /undo          직전 트랜잭션 되돌리기
    /clear         대화 기록 비우기 (모델은 유지 — 재로드 없음)
    /quit          종료 (Ctrl+D 동일)

  ${bold("승인 프롬프트")}
    y  실행    n  취소    a  이 세션 동안 같은 대상 계속 허용
    ${dim("삭제(ask_always)와 되돌릴 수 없는 작업(R3)에는 a 가 제공되지 않는다.")}

  ${bold("셸에서")}
    onmac history          되돌릴 수 있는 변경 이력
    onmac undo [--tx ID]   되돌리기
    onmac audit --verify   감사 로그 무결성 검증
`;
