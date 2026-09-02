import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import type { PolicyEngine } from "../core/policy.ts";
import { expand } from "../core/policy.ts";
import { MemoryStore, chunkText } from "./store.ts";

/**
 * 회상 색인기.
 *
 * 무엇을 기억할지는 신뢰 정책이 정한다 — policy.check("read") 가 deny 인 파일은
 * 기억에도 넣지 않는다. .env 와 키 파일이 검색 인덱스에 평문으로 복제되는 것을
 * 원천 차단하는 지점이 정확히 여기다.
 */

export interface Embedder {
  embed(texts: string[], kind: "query" | "passage"): Promise<number[][]>;
}

export interface ImageDescriber {
  describeImage(path: string): Promise<string>;
}

const TEXT_EXTS = new Set([
  ".md", ".txt", ".json", ".csv", ".yaml", ".yml", ".toml", ".html", ".xml",
  ".ts", ".tsx", ".js", ".py", ".sh", ".sql", ".log",
]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".venv", "venv", "__pycache__",
  "models", ".cache", "Library", ".Trash",
]);
const MAX_TEXT_BYTES = 2 * 1024 * 1024; // 색인용 상한. 큰 파일은 앞부분만
const EMBED_BATCH = 16;

export interface IndexProgress {
  scanned: number;
  indexed: number;
  skippedPolicy: number;
  imagesDescribed: number;
  imageFailures: number;
  removed: number;
}

export interface IndexOptions {
  /** 이미지 서술은 17GB VLM 적재가 필요해서 명시 opt-in 이다. */
  images?: boolean;
  onFile?: (path: string, what: "index" | "skip" | "describe") => void;
}

export async function indexRoots(
  roots: string[],
  policy: PolicyEngine,
  store: MemoryStore,
  embedder: Embedder,
  describer: ImageDescriber | undefined,
  opts: IndexOptions = {},
): Promise<IndexProgress> {
  const prog: IndexProgress = { scanned: 0, indexed: 0, skippedPolicy: 0, imagesDescribed: 0, imageFailures: 0, removed: 0 };

  for (const root of roots) {
    const rootAbs = expand(root);
    const seen = new Set<string>();
    await walk(rootAbs, policy, prog, seen, store, embedder, describer, opts);
    prog.removed += store.removeMissing(seen, rootAbs);
  }
  return prog;
}

async function walk(
  dir: string,
  policy: PolicyEngine,
  prog: IndexProgress,
  seen: Set<string>,
  store: MemoryStore,
  embedder: Embedder,
  describer: ImageDescriber | undefined,
  opts: IndexOptions,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // 권한 없는 디렉토리는 조용히 지나간다
  }

  for (const e of entries) {
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);

    if (e.isDirectory()) {
      await walk(p, policy, prog, seen, store, embedder, describer, opts);
      continue;
    }
    if (!e.isFile()) continue;

    const ext = extname(e.name).toLowerCase();
    const isText = TEXT_EXTS.has(ext);
    const isImage = IMAGE_EXTS.has(ext);
    if (!isText && !isImage) continue;

    prog.scanned++;

    // 기억의 경계 = 정책의 경계. deny 파일은 인덱스에 존재한 적도 없어야 한다.
    if (policy.check("read", p).verdict !== "allow") {
      prog.skippedPolicy++;
      opts.onFile?.(p, "skip");
      continue;
    }

    seen.add(p);
    let st;
    try {
      st = await stat(p);
    } catch {
      continue;
    }
    if (!store.needsIndex(p, st.mtimeMs)) continue;

    if (isText) {
      const buf = await readFile(p);
      const text = buf.subarray(0, MAX_TEXT_BYTES).toString("utf8");
      // 파일명·날짜를 본문에 붙인다 — "8월에 받은 견적서" 같은 시간·이름 질의를 살린다
      const header = `[파일: ${basename(p)} · 수정: ${new Date(st.mtimeMs).toISOString().slice(0, 10)}]\n`;
      const chunks = chunkText(header + text);
      if (chunks.length === 0) continue;
      const vecs = await embedBatched(embedder, chunks);
      store.replaceFile(p, st.mtimeMs, "text", chunks.map((t, i) => ({ text: t, vec: vecs[i]! })));
      prog.indexed++;
      opts.onFile?.(p, "index");
    } else if (isImage && opts.images && describer) {
      opts.onFile?.(p, "describe");
      try {
        const desc = await describer.describeImage(p);
        const dated = `[스크린샷/이미지: ${basename(p)} · ${new Date(st.mtimeMs).toISOString().slice(0, 10)}]\n${desc}`;
        const vecs = await embedBatched(embedder, [dated]);
        store.replaceFile(p, st.mtimeMs, "image", [{ text: dated, vec: vecs[0]! }]);
        prog.indexed++;
        prog.imagesDescribed++;
      } catch {
        // 손상된 이미지, 확장자만 png 인 파일은 현실에 흔하다.
        // 한 장의 실패가 색인 전체를 죽여선 안 된다 — 건너뛰고 계속 간다.
        prog.imageFailures++;
      }
    }
  }
}

async function embedBatched(embedder: Embedder, texts: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const vecs = await embedder.embed(batch, "passage");
    for (const v of vecs) out.push(Float32Array.from(v));
  }
  return out;
}
