import { ANSI, cyan, dim, gray, green, isTTY, red, yellow } from "./theme.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * 단일 라인 진행 표시기.
 *
 * 모델 로드에 30초가 걸리는데 그동안 화면이 멎어 있으면 사용자는 멈춘 줄 안다.
 * 경과 시간을 같이 보여주는 이유가 그것이다 — "느린 것"과 "죽은 것"을 구분해준다.
 *
 * ponytail: 프로세스당 하나뿐인 터미널 한 줄을 다루므로 싱글턴으로 둔다.
 * 승인 프롬프트가 끼어들 때 stop/resume 만 지키면 상태 관리가 더 필요 없다.
 */
class Status {
  private timer?: NodeJS.Timeout;
  private frame = 0;
  private text = "";
  private startedAt = 0;
  private active = false;

  start(text: string): void {
    this.text = text;
    this.startedAt = Date.now();
    if (!isTTY) {
      process.stdout.write(`${text}…\n`);
      return;
    }
    if (this.active) return;
    this.active = true;
    process.stdout.write(ANSI.hideCursor);
    this.timer = setInterval(() => this.render(), 80);
    this.render();
  }

  /** 실행 중 문구만 교체한다. 경과 시간은 이어서 센다. */
  update(text: string): void {
    this.text = text;
    if (!isTTY) process.stdout.write(`  ${text}\n`);
  }

  /** 새 단계로 넘어갈 때. 경과 시간을 0부터 다시 센다. */
  phase(text: string): void {
    this.startedAt = Date.now();
    this.update(text);
  }

  private render(): void {
    const f = FRAMES[this.frame++ % FRAMES.length]!;
    const secs = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    process.stdout.write(`${ANSI.clearLine}${cyan(f)} ${this.text} ${gray(`${secs}s`)}`);
  }

  /** 진행 표시를 지운다. 승인 프롬프트를 띄우기 전에 반드시 호출해야 한다. */
  pause(): void {
    if (!this.active) return;
    clearInterval(this.timer);
    this.timer = undefined as never;
    this.active = false;
    process.stdout.write(`${ANSI.clearLine}${ANSI.showCursor}`);
  }

  /** 완료 표시를 남기고 끝낸다. */
  done(text?: string): void {
    const secs = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    this.pause();
    if (text) process.stdout.write(`${green("✔")} ${text} ${gray(`${secs}s`)}\n`);
  }

  fail(text: string): void {
    this.pause();
    process.stdout.write(`${red("✖")} ${text}\n`);
  }

  get running(): boolean {
    return this.active;
  }
}

export const status = new Status();

/** 프로세스가 어떻게 끝나든 커서는 되돌려놓는다. */
for (const sig of ["exit", "SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    status.pause();
    if (sig !== "exit") process.exit(130);
  });
}

export const icon = {
  tool: (name: string) => `${dim("⚙")} ${name}`,
  warn: (s: string) => `${yellow("⚠")}  ${s}`,
  info: (s: string) => `${dim(s)}`,
};
