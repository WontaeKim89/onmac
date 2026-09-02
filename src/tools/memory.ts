import { homedir } from "node:os";
import type { ToolSpec } from "../types.ts";
import { MemoryStore } from "../memory/store.ts";
import type { Embedder } from "../memory/indexer.ts";

/**
 * 회상 검색 툴 — 모델이 대화 중 "그때 그거" 를 찾을 때 쓴다.
 *
 * 인덱스에는 정책이 허용한 파일만 들어 있으므로(색인 시점에 검사),
 * 검색 결과가 deny 경로를 노출할 일은 구조적으로 없다.
 */
export function buildMemoryTools(embedder: Embedder | undefined): ToolSpec[] {
  return [
    {
      name: "recall_search",
      description:
        "사용자의 파일·스크린샷 회상 인덱스를 의미 기반으로 검색한다. " +
        "\"저번에 캡처한 에러 화면\", \"지난달 받은 견적서\" 같은 질문에 사용하라. " +
        "인덱스가 비어 있으면 사용자에게 `onmac index` 실행을 안내하라.",
      action: "read",
      reversibility: "R0",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "찾으려는 내용의 자연어 서술" },
          k: { type: "number", description: "결과 개수 (기본 6)" },
        },
        required: ["query"],
      },
      async run(args) {
        if (!embedder) {
          return "회상 인덱스는 mlx 백엔드에서만 동작합니다 (onmac.toml 의 backend).";
        }
        const query = String(args["query"] ?? "").trim();
        if (!query) throw new Error("query 가 비어 있습니다.");

        const store = new MemoryStore();
        try {
          const stats = store.stats();
          if (stats.chunks === 0) {
            return "회상 인덱스가 비어 있습니다. 터미널에서 `onmac index` 를 먼저 실행하십시오.";
          }
          const [vec] = await embedder.embed([query], "query");
          const hits = store.search(Float32Array.from(vec!), Math.min(12, Number(args["k"] ?? 6)));
          if (hits.length === 0) return "관련 항목을 찾지 못했습니다.";
          return hits
            .map((h, i) => {
              const when = new Date(h.mtimeMs).toISOString().slice(0, 10);
              const kind = h.kind === "image" ? "이미지" : "문서";
              return `${i + 1}. [${kind} · ${when} · 유사도 ${h.score.toFixed(3)}] ${h.path.replace(homedir(), "~")}\n   ${h.snippet.replace(/\n/g, " ").slice(0, 160)}`;
            })
            .join("\n");
        } finally {
          store.close();
        }
      },
    },
  ];
}
