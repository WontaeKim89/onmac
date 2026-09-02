/**
 * onmac 전역 타입.
 *
 * 여기 정의된 Action / Op 는 정책 엔진과 롤백 엔진이 공유한다.
 * 새 종류를 추가하면 policy.ts 와 tx.ts 의 switch 문이 컴파일 에러를 낸다 (의도된 동작).
 */

/** 정책 판단 단위. 툴이 아니라 "행위"로 권한을 관리한다. */
export type Action =
  | "read" // 파일/디렉토리 읽기
  | "list" // 목록 조회
  | "write" // 파일 생성·수정
  | "move" // 이동·이름변경
  | "delete" // 삭제 (휴지통 이동)
  | "shell" // 쉘 명령 실행
  | "app_control" // AppleScript 를 통한 앱 제어
  | "ui_control" // System Events UI 스크립팅 (Accessibility 필요, 기본 비활성)
  | "settings"; // 시스템 설정 변경

export type Verdict = "allow" | "ask" | "ask_always" | "deny";

export interface Decision {
  verdict: Verdict;
  reason: string;
}

/**
 * 되돌리기 등급.
 * R3 는 트랜잭션으로 복구가 불가능하므로 별도 확인 절차를 거친다.
 */
export type Reversibility =
  | "R0" // 무해 (읽기)
  | "R1" // 파일 스냅샷/저널로 완전 복구
  | "R2" // 역연산으로 복구 (생성한 객체 삭제, 설정 원복)
  | "R3"; // 복구 불가 (전송, push 등)

/** 롤백 저널에 기록되는 단위 연산. 각 항목은 역연산이 정의되어 있어야 한다. */
export type Op =
  | { kind: "create"; path: string }
  | { kind: "modify"; path: string; snap: string }
  | { kind: "move"; from: string; to: string }
  | { kind: "delete"; path: string; trash: string }
  | { kind: "appAdd"; app: string; uid: string }
  | { kind: "settingChange"; key: string; before: string; after: string }
  | { kind: "volumeSnapshot"; name: string; reason: string };

/**
 * 승인 카드에 띄울 결과-언어 서술.
 * 사용자가 판단에 필요한 건 툴 이름이 아니라 이 세 줄이다:
 * 무엇이 바뀌나 / 최악엔 무엇을 잃나 / 잘못되면 어떻게 되돌리나.
 */
export interface Outcome {
  title: string;
  changes: string;
  loses: string;
  recover: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema. zod 스키마에서 생성한다. */
  parameters: Record<string, unknown>;
  action: Action;
  reversibility: Reversibility;
  /** 인자에서 정책 검사 대상 경로를 뽑아내는 함수. 경로 개념이 없는 툴은 undefined. */
  targetOf?: (args: Record<string, unknown>) => string | undefined;
  /** 결과-언어 서술. 없으면 승인 카드가 인자 나열로 떨어진다 (전문가용 뷰). */
  describe?: (args: Record<string, unknown>) => Outcome;
  /** 진행 로그 한 줄에 표시할 요약. 없으면 대상 경로를 쓴다. */
  label?: (args: Record<string, unknown>) => string;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

export interface ToolContext {
  /** 현재 트랜잭션. 되돌릴 수 있는 연산은 반드시 여기에 record 해야 한다. */
  tx: { id: string; record: (op: Op) => Promise<void> };
  cwd: string;
}

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface Message {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  /** tool 역할 메시지가 응답하는 호출 id */
  toolCallId?: string;
  /** 비전 입력 이미지 경로 */
  images?: string[];
}
