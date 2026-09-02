import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { packageRoot } from "./config.ts";
import { exists } from "./snapshot.ts";

/**
 * models/ 디렉토리의 설치된 대화 모델 목록.
 *
 * 판별 기준: config.json 이 있고, safetensors 가중치가 있으며,
 * bert 계열(임베딩 모델 — e5)이 아닌 것. 새 모델 추가 = 폴더 하나 추가로 끝.
 */
export interface InstalledModel {
  name: string;
  path: string;
  sizeGb: string;
}

export async function scanModels(): Promise<InstalledModel[]> {
  const root = join(packageRoot, "models");
  if (!(await exists(root))) return [];
  const out: InstalledModel[] = [];

  for (const name of await readdir(root)) {
    const dir = join(root, name);
    const cfgPath = join(dir, "config.json");
    if (!(await exists(cfgPath))) continue;
    try {
      const cfg = JSON.parse(await readFile(cfgPath, "utf8")) as { model_type?: string };
      if ((cfg.model_type ?? "").includes("bert")) continue; // 임베딩 모델 제외

      let bytes = 0;
      let hasWeights = false;
      for (const f of await readdir(dir)) {
        if (f.endsWith(".safetensors")) {
          hasWeights = true;
          bytes += (await stat(join(dir, f))).size;
        }
      }
      if (!hasWeights) continue;
      out.push({ name, path: dir, sizeGb: (bytes / 1024 ** 3).toFixed(1) });
    } catch {
      continue; // 깨진 폴더는 목록에서 제외
    }
  }
  return out.sort((a, b) => Number(a.sizeGb) - Number(b.sizeGb));
}

/**
 * onmac.toml 의 [llm.mlx] modelPath 를 교체해 선택을 영속화한다.
 * 사용자 파일이므로 통째로 재생성하지 않고 해당 줄만 바꾸고, .bak 을 남긴다.
 */
/** onmac 이 참조할 수 있는 모든 설정 파일 후보. */
async function candidateConfigs(): Promise<string[]> {
  const { USER_CONFIG } = await import("./config.ts");
  const cands = [
    USER_CONFIG,
    join(process.cwd(), "onmac.toml"),
    join(packageRoot, "onmac.toml"),
  ];
  const out: string[] = [];
  for (const c of cands) if ((await exists(c)) && !out.includes(c)) out.push(c);
  return out;
}

/** 지금 쓰는 설정 말고 다른 설정 파일들의 경로. */
export async function otherConfigPaths(active: string): Promise<string[]> {
  return (await candidateConfigs()).filter((c) => c !== active);
}

/** 모델이 어긋난 설정 파일들만. /model 이 "전부 맞추기" 를 제안할 대상. */
export async function divergentConfigPaths(active: string): Promise<string[]> {
  return (await otherConfigModels(active)).map((o) => o.configPath);
}

async function modelPathIn(configPath: string): Promise<string | undefined> {
  try {
    const text = await readFile(configPath, "utf8");
    return /^\s*modelPath\s*=\s*"([^"]+)"/m.exec(text.split("[llm.mlx]")[1] ?? "")?.[1];
  } catch {
    return undefined;
  }
}

/**
 * 다른 설정 파일이 **다른** 모델을 가리키는 경우만 돌려준다.
 * 같은 모델이면 알릴 이유가 없다 — 경고가 늘 떠 있으면 아무도 안 읽는다.
 */
export async function otherConfigModels(
  active: string,
): Promise<Array<{ configPath: string; modelName: string }>> {
  const mine = await modelPathIn(active);
  const out: Array<{ configPath: string; modelName: string }> = [];
  for (const c of await otherConfigPaths(active)) {
    const theirs = await modelPathIn(c);
    if (theirs && theirs !== mine) {
      out.push({ configPath: c, modelName: theirs.split("/").pop() ?? theirs });
    }
  }
  return out;
}

export async function persistMlxModelPath(configPath: string, newPath: string): Promise<void> {
  const text = await readFile(configPath, "utf8");
  const lines = text.split("\n");
  let inMlx = false;
  let done = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\[llm\.mlx\]/.test(line)) inMlx = true;
    else if (/^\[/.test(line)) inMlx = false;
    if (inMlx && !done && /^\s*modelPath\s*=/.test(line)) {
      lines[i] = `modelPath = "${newPath}"`;
      done = true;
    }
  }
  if (!done) throw new Error("onmac.toml 에서 [llm.mlx] modelPath 를 찾지 못했습니다.");
  await writeFile(configPath + ".bak", text);
  await writeFile(configPath, lines.join("\n"));
}
