import { createInterface, type Interface } from "node:readline";

/**
 * 프로세스 전역 단일 입력 큐.
 *
 * 두 가지 실제 버그가 이 설계를 강제한다:
 *   1) readline 을 여러 개 만들면 키 입력이 인터페이스 사이에서 경쟁한다 —
 *      승인 카드에 y 를 눌러도 메인 루프가 삼키고, 화면엔 yy 이중 에코가 찍히며,
 *      승인은 빈 입력을 받아 "거부"가 된다.
 *   2) 파이프 입력은 질문보다 먼저 도착한다. 대기 중인 질문이 없을 때 온 line 은
 *      그냥 버려져서 두 번째 질문부터 영원히 대기한다.
 *
 * 해법: readline 은 하나, 도착한 줄은 큐에 쌓고, question() 은 큐에서 꺼낸다.
 */

let rl: Interface | undefined;
let closed = false;
const pending: string[] = [];
let waiter: ((line: string | null) => void) | null = null;

function ensure(): void {
  if (rl || closed) return;
  rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", (line) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(line);
    } else {
      pending.push(line);
    }
  });
  rl.on("close", () => {
    closed = true;
    rl = undefined;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(null);
    }
  });
}

/** 다음 입력 한 줄. EOF(Ctrl+D)면 null — 호출부는 취소/종료로 해석한다. */
export function question(text: string): Promise<string | null> {
  ensure();
  process.stdout.write(text);
  if (pending.length > 0) return Promise.resolve(pending.shift()!);
  if (closed) return Promise.resolve(null);
  return new Promise((res) => {
    waiter = res;
  });
}

export function isClosed(): boolean {
  return closed;
}

/** raw 키 입력 모드(설정 화면)가 stdin 을 직접 쓸 동안 readline 을 재운다. */
export function pausePrompt(): void {
  rl?.pause();
}

export function resumePrompt(): void {
  rl?.resume();
}

export function closePrompt(): void {
  rl?.close();
}
