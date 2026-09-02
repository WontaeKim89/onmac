import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import type { Verdict } from "../types.ts";
import { exists } from "./snapshot.ts";
import type { PolicyConfig } from "./policy.ts";

export interface OnmacConfig {
  llm: {
    backend: "llamacpp" | "mlx";
    maxTurns: number;
    maxKvSize: number;
    /** 사고 과정 토큰. 끄면 빨라지고, 어려운 추론에서는 켜는 편이 낫다. */
    thinking: boolean;
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
  /** 설정 파일이 있는 디렉토리. 상대 경로는 전부 여기 기준으로 풀린다. */
  root: string;
  configPath: string;
}

/**
 * 설치된 패키지 루트.
 *
 * 소스에서 직접 실행할 때(src/core/)와 빌드본으로 실행할 때(dist/src/core/)의
 * 깊이가 다르므로 고정 상대경로를 쓸 수 없다. package.json 이 나올 때까지 올라간다.
 */
function findPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export const packageRoot = findPackageRoot();

export const USER_CONFIG = join(homedir(), ".config", "onmac", "onmac.toml");

/**
 * 설정 파일 탐색 순서.
 *
 * 어느 경로에서 `onmac` 을 쳐도 동작해야 하므로, 현재 디렉토리에서 위로 훑다가
 * 없으면 사용자 전역 설정으로 떨어진다. git 이 .git 을 찾는 방식과 같다.
 * 프로젝트별로 허용 범위를 다르게 두고 싶을 때 그 디렉토리에 onmac.toml 만
 * 두면 되는 것도 이 순서 덕분이다.
 */
export async function resolveConfigPath(cwd = process.cwd()): Promise<string | undefined> {
  const explicit = process.env["ONMAC_CONFIG"];
  if (explicit) return resolve(explicit);

  let dir = resolve(cwd);
  const home = homedir();
  for (;;) {
    const candidate = join(dir, "onmac.toml");
    if (await exists(candidate)) return candidate;
    const parent = dirname(dir);
    // 홈 디렉토리를 넘어 루트까지 올라가지 않는다. 남의 설정을 주워오면 안 된다.
    if (parent === dir || dir === home) break;
    dir = parent;
  }
  if (await exists(USER_CONFIG)) return USER_CONFIG;
  return undefined;
}

export async function load(cwd = process.cwd()): Promise<OnmacConfig> {
  const path = await resolveConfigPath(cwd);
  if (!path) {
    throw new Error(
      "설정 파일을 찾지 못했습니다.\n\n" +
        "  onmac init          전역 설정 생성 (~/.config/onmac/onmac.toml)\n" +
        "  onmac init --here   현재 디렉토리에 생성\n\n" +
        "허용 경로를 명시하기 전까지 onmac 은 아무 작업도 수행하지 않습니다.",
    );
  }

  const dir = dirname(path);
  const raw = parse(await readFile(path, "utf8")) as Record<string, any>;
  const llm = raw["llm"] ?? {};
  const rollback = raw["rollback"] ?? {};

  return {
    root: dir,
    configPath: path,
    llm: {
      backend: llm.backend === "mlx" ? "mlx" : "llamacpp",
      maxTurns: Number(llm.maxTurns ?? 12),
      maxKvSize: Number(llm.maxKvSize ?? 32768),
      thinking: llm.thinking === true,
      llamacpp: {
        modelPath: resolve(dir, llm.llamacpp?.modelPath ?? "models/model.gguf"),
        ...(llm.llamacpp?.mmprojPath ? { mmprojPath: resolve(dir, llm.llamacpp.mmprojPath) } : {}),
      },
      mlx: {
        modelPath: resolve(dir, llm.mlx?.modelPath ?? join(packageRoot, "models/Qwen3.8-27B-4bit")),
        python: resolve(dir, llm.mlx?.python ?? join(packageRoot, ".venv/bin/python")),
      },
    },
    policy: {
      roots: { allow: raw["roots"]?.allow ?? [], deny: raw["roots"]?.deny ?? [] },
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

/**
 * `onmac init` — 설정 파일을 만든다.
 *
 * 모델·파이썬 경로는 설치된 패키지 위치를 보고 절대경로로 박아 넣는다.
 * 전역 설정은 어느 디렉토리에서 실행될지 모르므로 상대경로를 쓸 수 없다.
 */
export async function init(target: string): Promise<string> {
  if (await exists(target)) throw new Error(`이미 존재합니다: ${target}`);

  const template = await readFile(join(packageRoot, "onmac.example.toml"), "utf8");
  const mlxModel = join(packageRoot, "models/Qwen3.8-27B-4bit");
  const python = join(packageRoot, ".venv/bin/python");
  const hasMlx = (await exists(mlxModel)) && (await exists(python));

  const filled = template
    .replace(/^backend = "llamacpp"/m, `backend = "${hasMlx ? "mlx" : "llamacpp"}"`)
    .replace(/^modelPath = "models\/Qwen3\.8-27B-4bit"/m, `modelPath = "${mlxModel}"`)
    .replace(/^python = "\.venv\/bin\/python"/m, `python = "${python}"`)
    .replace(
      /^modelPath = "models\/Qwen3\.8-27B-Q4_K_M\.gguf"/m,
      `modelPath = "${join(packageRoot, "models/Qwen3.8-27B-Q4_K_M.gguf")}"`,
    );

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, filled);
  return target;
}
