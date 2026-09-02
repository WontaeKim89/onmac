/**
 * 터미널 색상/기능 감지.
 *
 * 색을 쓸 수 없는 환경(파이프, CI, NO_COLOR)에서는 전부 빈 문자열로 떨어져
 * 출력이 제어문자로 더러워지지 않는다. 판정은 한 번만 하고 재사용한다.
 */
const noColorEnv = process.env["NO_COLOR"] !== undefined && process.env["NO_COLOR"] !== "";

export const isTTY = process.stdout.isTTY === true;
export const useColor = isTTY && !noColorEnv;
export const useTrueColor =
  useColor && /truecolor|24bit/i.test(process.env["COLORTERM"] ?? "");

const wrap = (open: string) => (s: string) => (useColor ? `\x1b[${open}m${s}\x1b[0m` : s);

export const bold = wrap("1");
export const dim = wrap("2");
export const italic = wrap("3");
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");
export const blue = wrap("34");
export const magenta = wrap("35");
export const cyan = wrap("36");
export const gray = wrap("90");

/** 24비트 색. 미지원 터미널에서는 원문 그대로 반환한다. */
export function rgb(r: number, g: number, b: number, s: string): string {
  if (!useColor) return s;
  if (!useTrueColor) return cyan(s);
  return `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
}

/** 두 색 사이를 문자 단위로 보간한다. 배너 그라데이션에 쓴다. */
export function gradient(text: string, from: [number, number, number], to: [number, number, number]): string {
  if (!useColor) return text;
  const chars = [...text];
  const visible = chars.filter((c) => c !== " ").length || 1;
  let i = 0;
  return chars
    .map((c) => {
      if (c === " ") return c;
      const t = i++ / Math.max(1, visible - 1);
      const ch = (a: number, b: number) => Math.round(a + (b - a) * t);
      return rgb(ch(from[0], to[0]), ch(from[1], to[1]), ch(from[2], to[2]), c);
    })
    .join("");
}

export const ANSI = {
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  clearLine: "\x1b[2K\r",
  up: (n = 1) => `\x1b[${n}A`,
};
