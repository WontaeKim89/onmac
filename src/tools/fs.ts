import { readFile, readdir, stat, mkdir, rename } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import type { ToolSpec } from "../types.ts";
import { expand } from "../core/policy.ts";
import { snapshot, atomicWrite, toTrash, exists } from "../core/snapshot.ts";

const str = (o: Record<string, unknown>, k: string): string => {
  const v = o[k];
  if (typeof v !== "string" || v.length === 0) throw new Error(`인자 '${k}' 가 필요합니다.`);
  return v;
};

export const listDir: ToolSpec = {
  name: "list_dir",
  description:
    "디렉토리를 조회한다. 기본은 개수·확장자 분포·최근 항목 요약이며, " +
    "전체 목록이 정말 필요할 때만 full=true 를 쓴다.",
  action: "list",
  reversibility: "R0",
  targetOf: (a) => a["path"] as string,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "조회할 디렉토리 절대경로" },
      full: { type: "boolean", description: "전체 목록 반환 (기본 false)" },
    },
    required: ["path"],
  },
  async run(args) {
    const dir = expand(str(args, "path"));
    const entries = await readdir(dir, { withFileTypes: true });

    const rows = await Promise.all(
      entries.map(async (e) => {
        const isDir = e.isDirectory();
        try {
          const s = await stat(join(dir, e.name));
          return { name: e.name, isDir, size: s.size, mtime: s.mtime.getTime() };
        } catch {
          return { name: e.name, isDir, size: 0, mtime: 0 };
        }
      }),
    );

    const files = rows.filter((r) => !r.isDir);
    const dirs = rows.filter((r) => r.isDir);
    const line = (r: (typeof rows)[number]) =>
      `${r.isDir ? "DIR " : "FILE"} ${String(Math.round(r.size / 1024)).padStart(7)}KB  ${new Date(r.mtime).toISOString().slice(0, 10)}  ${r.name}`;

    if (args["full"] === true) {
      // 전체 목록은 명시 요청일 때만. 그래도 상한은 둔다 — 잘렸다는 사실을 숨기지 않는다.
      const shown = rows.slice(0, 300);
      const note = rows.length > shown.length ? `\n… ${rows.length - shown.length}개 생략됨` : "";
      return `${dir}\n파일 ${files.length}개, 디렉토리 ${dirs.length}개\n${shown.map(line).join("\n")}${note}`;
    }

    // 요약 모드. 모델이 목록을 그대로 받아쓰지 않도록 처음부터 압축해서 준다.
    const byExt = new Map<string, number>();
    for (const f of files) {
      const ext = f.name.includes(".") ? f.name.slice(f.name.lastIndexOf(".")).toLowerCase() : "(없음)";
      byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
    }
    const extLine = [...byExt.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([e, n]) => `${e} ${n}`)
      .join(", ");
    const totalMb = Math.round(files.reduce((s, f) => s + f.size, 0) / 1_048_576);
    const recent = [...rows].sort((a, b) => b.mtime - a.mtime).slice(0, 15);

    return [
      dir,
      `파일 ${files.length}개, 디렉토리 ${dirs.length}개, 합계 약 ${totalMb}MB`,
      `확장자 분포: ${extLine || "-"}`,
      `최근 수정 15건:`,
      ...recent.map(line),
      `(전체 목록이 필요하면 full=true 로 다시 호출)`,
    ].join("\n");
  },
};

export const readTextFile: ToolSpec = {
  name: "read_file",
  description: "텍스트 파일 내용을 읽는다. 큰 파일은 앞부분만 반환한다.",
  action: "read",
  reversibility: "R0",
  targetOf: (a) => a["path"] as string,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "읽을 파일 절대경로" },
      maxBytes: { type: "number", description: "최대 읽을 바이트 수 (기본 200000)" },
    },
    required: ["path"],
  },
  async run(args) {
    const p = expand(str(args, "path"));
    const limit = Number(args["maxBytes"] ?? 200_000);
    const s = await stat(p);
    const buf = await readFile(p);
    const text = buf.subarray(0, limit).toString("utf8");
    return s.size > limit ? `${text}\n\n… (총 ${s.size} 바이트 중 앞 ${limit} 바이트)` : text;
  },
};

export const writeTextFile: ToolSpec = {
  name: "write_file",
  description: "파일에 내용을 쓴다. 기존 파일은 스냅샷을 남기고 덮어쓴다.",
  action: "write",
  reversibility: "R1",
  targetOf: (a) => a["path"] as string,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "쓸 파일 절대경로" },
      content: { type: "string", description: "파일 내용" },
    },
    required: ["path", "content"],
  },
  async run(args, ctx) {
    const p = expand(str(args, "path"));
    const content = str(args, "content");
    if (await exists(p)) {
      // 저널 기록이 실제 조작보다 먼저다 (write-ahead). 순서를 바꾸면 복구가 깨진다.
      const snap = await snapshot(ctx.tx.id, p);
      await ctx.tx.record({ kind: "modify", path: p, snap });
    } else {
      await ctx.tx.record({ kind: "create", path: p });
    }
    await atomicWrite(p, content);
    return `작성 완료: ${p} (${Buffer.byteLength(content)} 바이트)`;
  },
};

export const moveFile: ToolSpec = {
  name: "move_file",
  description: "파일이나 디렉토리를 이동하거나 이름을 바꾼다.",
  action: "move",
  reversibility: "R1",
  targetOf: (a) => a["to"] as string,
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "원본 절대경로" },
      to: { type: "string", description: "목적지 절대경로" },
    },
    required: ["from", "to"],
  },
  async run(args, ctx) {
    const from = expand(str(args, "from"));
    const to = expand(str(args, "to"));
    if (await exists(to)) throw new Error(`목적지가 이미 존재합니다: ${to}`);
    await ctx.tx.record({ kind: "move", from, to });
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    return `이동: ${basename(from)} → ${to}`;
  },
};

export const deleteFile: ToolSpec = {
  name: "delete_file",
  description: "파일을 삭제한다. 실제로는 onmac 휴지통으로 옮기며 언제든 복구할 수 있다.",
  action: "delete",
  reversibility: "R1",
  targetOf: (a) => a["path"] as string,
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "삭제할 파일 절대경로" } },
    required: ["path"],
  },
  async run(args, ctx) {
    const p = expand(str(args, "path"));
    const txId = ctx.tx.id;
    const trash = await toTrash(txId, p);
    await ctx.tx.record({ kind: "delete", path: p, trash });
    return `휴지통으로 이동: ${p}  (onmac undo 로 복구 가능)`;
  },
};

export const fsTools = [listDir, readTextFile, writeTextFile, moveFile, deleteFile];
