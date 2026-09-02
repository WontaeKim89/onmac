import { watch, type FSWatcher } from "node:fs";
import { stat, readdir } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import type { PolicyEngine } from "../core/policy.ts";
import { expand } from "../core/policy.ts";
import { MemoryStore, chunkText } from "./store.ts";
import type { Embedder, ImageDescriber } from "./indexer.ts";

/**
 * 상주 감시자 — "부르면 오는 도구" 를 "이미 와 있는 존재" 로 바꾸는 부품.
 *
 * 클라우드 에이전트는 토큰당 과금이라 상주할 수 없다. 로컬은 한계비용이 0이라
 * 파일이 생기는 순간 읽고 색인해둘 수 있다. 스크린샷을 찍는 이유가 "기억하려고"인데
 * 지금은 찍는 순간 잊혀진다 — 이 파일이 그 간극을 메운다.
 *
 * 설계 원칙:
 *   - 정책이 기억의 경계다. deny 파일은 감시 대상에서도 제외한다.
 *   - 조용해야 한다. 사용자가 타이핑하는 동안 CPU 를 뺏으면 안 되므로
 *     디바운스 후 한 번에, 그리고 유휴 간격을 두고 처리한다.
 *   - 실패는 삼킨다. 감시자가 죽어서 대화가 끊기면 안 된다.
 */

const TEXT_EXTS = new Set([
  ".md", ".txt", ".json", ".csv", ".yaml", ".yml", ".toml", ".html", ".xml",
  ".ts", ".tsx", ".js", ".py", ".sh", ".sql", ".log",
]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".venv", "models", ".cache"]);

const DEBOUNCE_MS = 1500; // 파일 쓰기가 끝나기를 기다린다 (스크린샷은 여러 번 write 된다)
const GAP_MS = 400; // 항목 사이 숨 고르기 — 대화 응답성을 뺏지 않으려고

export interface WatchEvent {
  path: string;
  kind: "text" | "image";
  /** 이미지면 모델이 만든 서술, 텍스트면 첫 줄 */
  summary: string;
  /** 같은 내용의 과거 항목 (있으면 "전에도 이거 찍으셨어요") */
  echo?: { path: string; when: string; score: number };
}

export interface WatcherDeps {
  roots: string[];
  policy: PolicyEngine;
  store: MemoryStore;
  embedder: Embedder;
  describer?: ImageDescriber;
  /** 새로 기억한 것을 알린다. CLI 가 화면에 띄우거나 알림을 보낸다. */
  onIndexed: (e: WatchEvent) => void;
  /** 이미지 판독은 비전 모델이 필요하다. 끄면 텍스트만 감시한다. */
  images: boolean;
}

export class MemoryWatcher {
  private watchers: FSWatcher[] = [];
  private pending = new Map<string, NodeJS.Timeout>();
  private busy = false;
  private queue: string[] = [];

  // Node 의 타입 스트리핑은 생성자 파라미터 프로퍼티를 지원하지 않는다 (풀어 쓴다)
  private readonly deps: WatcherDeps;

  constructor(deps: WatcherDeps) {
    this.deps = deps;
  }

  start(): void {
    for (const root of this.deps.roots) {
      const dir = expand(root);
      try {
        // recursive 는 macOS 에서 FSEvents 로 구현되어 있어 하위 전체를 저비용으로 본다
        const w = watch(dir, { recursive: true }, (_event, filename) => {
          if (filename) this.schedule(join(dir, filename.toString()));
        });
        w.on("error", () => {
          /* 권한 없는 하위 트리는 조용히 무시 */
        });
        this.watchers.push(w);
      } catch {
        continue;
      }
    }
  }

  stop(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  /** 같은 파일에 대한 연속 이벤트를 하나로 접는다. */
  private schedule(path: string): void {
    if (!this.relevant(path)) return;
    const prev = this.pending.get(path);
    if (prev) clearTimeout(prev);
    this.pending.set(
      path,
      setTimeout(() => {
        this.pending.delete(path);
        this.queue.push(path);
        void this.drain();
      }, DEBOUNCE_MS),
    );
  }

  private relevant(path: string): boolean {
    const name = basename(path);
    if (name.startsWith(".")) return false;
    if (path.split("/").some((seg) => SKIP_DIRS.has(seg))) return false;
    const ext = extname(name).toLowerCase();
    if (TEXT_EXTS.has(ext)) return true;
    return this.deps.images && IMAGE_EXTS.has(ext);
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length > 0) {
        const path = this.queue.shift()!;
        try {
          await this.ingest(path);
        } catch {
          /* 한 파일의 실패가 감시를 멈추게 하지 않는다 */
        }
        await new Promise((r) => setTimeout(r, GAP_MS));
      }
    } finally {
      this.busy = false;
    }
  }

  private async ingest(path: string): Promise<void> {
    // 기억의 경계 = 정책의 경계
    if (this.deps.policy.check("read", path).verdict !== "allow") return;

    let st;
    try {
      st = await stat(path);
    } catch {
      return; // 생겼다 지워진 임시 파일
    }
    if (!st.isFile() || st.size === 0) return;
    if (!this.deps.store.needsIndex(path, st.mtimeMs)) return;

    const ext = extname(path).toLowerCase();
    const when = new Date(st.mtimeMs).toISOString().slice(0, 10);

    if (IMAGE_EXTS.has(ext)) {
      if (!this.deps.images || !this.deps.describer) return;
      const desc = await this.deps.describer.describeImage(path);
      const text = `[스크린샷/이미지: ${basename(path)} · ${when}]\n${desc}`;
      const [vec] = await this.deps.embedder.embed([text], "passage");
      const v = Float32Array.from(vec!);

      // 색인하기 **전에** 과거의 비슷한 것을 찾는다 — 자기 자신이 1위로 잡히면 의미가 없다
      const echo = this.findEcho(v, path);
      this.deps.store.replaceFile(path, st.mtimeMs, "image", [{ text, vec: v }]);
      this.deps.onIndexed({
        path,
        kind: "image",
        summary: firstLine(desc),
        ...(echo ? { echo } : {}),
      });
      return;
    }

    const { readFile } = await import("node:fs/promises");
    const raw = (await readFile(path)).subarray(0, 2 * 1024 * 1024).toString("utf8");
    const header = `[파일: ${basename(path)} · 수정: ${when}]\n`;
    const chunks = chunkText(header + raw);
    if (chunks.length === 0) return;
    const vecs = await this.deps.embedder.embed(chunks.slice(0, 8), "passage");
    this.deps.store.replaceFile(
      path,
      st.mtimeMs,
      "text",
      chunks.slice(0, 8).map((t, i) => ({ text: t, vec: Float32Array.from(vecs[i]!) })),
    );
    this.deps.onIndexed({ path, kind: "text", summary: firstLine(raw) });
  }

  /** 과거에 같은 것을 본 적 있는가. 이게 "전에도 이거 찍으셨어요" 의 근거다. */
  private findEcho(vec: Float32Array, selfPath: string): WatchEvent["echo"] {
    const hits = this.deps.store.search(vec, 4).filter((h) => h.path !== selfPath);
    const top = hits[0];
    if (!top || top.score < 0.9) return undefined;
    return { path: top.path, when: new Date(top.mtimeMs).toISOString().slice(0, 10), score: top.score };
  }
}

function firstLine(s: string): string {
  return (s.split("\n").find((l) => l.trim().length > 0) ?? "").trim().slice(0, 90);
}

/** 감시 시작 전 놓친 변경을 따라잡는다 (데몬이 꺼져 있던 동안의 파일). */
export async function catchUp(
  roots: string[],
  store: MemoryStore,
  limit = 200,
): Promise<string[]> {
  const stale: string[] = [];
  for (const root of roots) {
    const dir = expand(root);
    try {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (stale.length >= limit) break;
        if (!e.isFile() || e.name.startsWith(".")) continue;
        const p = join(dir, e.name);
        const ext = extname(e.name).toLowerCase();
        if (!TEXT_EXTS.has(ext) && !IMAGE_EXTS.has(ext)) continue;
        try {
          const st = await stat(p);
          if (store.needsIndex(p, st.mtimeMs)) stale.push(p);
        } catch {
          continue;
        }
      }
    } catch {
      continue;
    }
  }
  return stale;
}
