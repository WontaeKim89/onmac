import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";
import type { Verdict } from "../types.ts";
import { exists } from "./snapshot.ts";
import type { PolicyConfig } from "./policy.ts";

export interface OnmacConfig {
  llm: {
    backend: "llamacpp" | "mlx";
    maxTurns: number;
    maxKvSize: number;
    llamacpp: { modelPath: string; mmprojPath?: string };
    mlx: { modelPath: string; python: string };
  };
  policy: PolicyConfig;
  rollback: {
    tier1Journal: boolean;
    tier2ApfsSnapshot: boolean;
    tier2ThresholdFiles: number;
    trashRetentionDays: number;
  };
  root: string;
}

/**
 * 설정 로드. 파일이 없으면 실행을 거부한다.
 *
 * "설정이 없으면 안전한 기본값으로 동작" 이 아니라 "설정이 없으면 동작하지 않음" 이다.
 * 사용자가 무엇을 허용했는지 명시적으로 적기 전까지는 파일 하나 건드리지 않는 게 맞다.
 */
export async function load(dir = process.cwd()): Promise<OnmacConfig> {
  const path = join(dir, "onmac.toml");
  if (!(await exists(path))) {
    throw new Error(
      `설정 파일이 없습니다: ${path}\n` +
        `  cp onmac.example.toml onmac.toml\n` +
        `허용 경로를 명시하기 전까지 onmac 은 아무 작업도 수행하지 않습니다.`,
    );
  }
  const raw = parse(await readFile(path, "utf8")) as Record<string, any>;

  const llm = raw["llm"] ?? {};
  const rollback = raw["rollback"] ?? {};
  return {
    root: resolve(dir),
    llm: {
      backend: llm.backend === "mlx" ? "mlx" : "llamacpp",
      maxTurns: Number(llm.maxTurns ?? 12),
      maxKvSize: Number(llm.maxKvSize ?? 32768),
      llamacpp: {
        modelPath: resolve(dir, llm.llamacpp?.modelPath ?? "models/model.gguf"),
        ...(llm.llamacpp?.mmprojPath ? { mmprojPath: resolve(dir, llm.llamacpp.mmprojPath) } : {}),
      },
      mlx: {
        modelPath: resolve(dir, llm.mlx?.modelPath ?? "models/Qwen3.8-27B-4bit"),
        python: resolve(dir, llm.mlx?.python ?? ".venv/bin/python"),
      },
    },
    policy: {
      roots: {
        allow: raw["roots"]?.allow ?? [],
        deny: raw["roots"]?.deny ?? [],
      },
      actions: (raw["actions"] ?? {}) as Record<string, Verdict>,
      limits: {
        maxFileMb: Number(raw["limits"]?.maxFileMb ?? 200),
        maxFilesPerCall: Number(raw["limits"]?.maxFilesPerCall ?? 500),
      },
    },
    rollback: {
      tier1Journal: rollback.tier1Journal !== false,
      tier2ApfsSnapshot: rollback.tier2ApfsSnapshot === true,
      tier2ThresholdFiles: Number(rollback.tier2ThresholdFiles ?? 100),
      trashRetentionDays: Number(rollback.trashRetentionDays ?? 30),
    },
  };
}
