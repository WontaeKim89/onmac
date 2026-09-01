import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ONMAC_DIR, exists } from "./snapshot.ts";

const AUDIT_LOG = join(ONMAC_DIR, "audit.jsonl");

export interface AuditEntry {
  ts: string;
  txId: string;
  action: string;
  tool: string;
  args: Record<string, unknown>;
  verdict: string;
  reason: string;
  result?: string;
  prevHash: string;
  hash?: string;
}

let lastHash = "";

const digest = (e: Omit<AuditEntry, "hash">) => createHash("sha256").update(JSON.stringify(e)).digest("hex");

/**
 * 감사 로그 기록.
 *
 * 각 레코드가 직전 레코드의 해시를 품는 해시 체인이다. 중간 레코드를 지우거나 고치면
 * 이후 전체 체인이 어긋나므로 `onmac audit --verify` 가 변조를 잡아낸다.
 * 로그 자체를 통째로 지우는 것은 막을 수 없다 — 그건 파일시스템 권한의 영역이다.
 */
export async function write(e: Omit<AuditEntry, "ts" | "prevHash" | "hash">): Promise<void> {
  await mkdir(ONMAC_DIR, { recursive: true });
  if (!lastHash) lastHash = await tailHash();
  const base = { ...e, ts: new Date().toISOString(), prevHash: lastHash };
  const entry: AuditEntry = { ...base, hash: digest(base) };
  lastHash = entry.hash!;
  await appendFile(AUDIT_LOG, JSON.stringify(entry) + "\n");
}

async function tailHash(): Promise<string> {
  if (!(await exists(AUDIT_LOG))) return "GENESIS";
  const lines = (await readFile(AUDIT_LOG, "utf8")).trim().split("\n");
  const last = lines.at(-1);
  return last ? String((JSON.parse(last) as AuditEntry).hash) : "GENESIS";
}

export async function verify(): Promise<{ ok: boolean; brokenAt?: number; total: number }> {
  if (!(await exists(AUDIT_LOG))) return { ok: true, total: 0 };
  const lines = (await readFile(AUDIT_LOG, "utf8")).trim().split("\n");
  let prev = "GENESIS";
  for (const [i, line] of lines.entries()) {
    const { hash, ...rest } = JSON.parse(line) as AuditEntry;
    if (rest.prevHash !== prev || digest(rest) !== hash) return { ok: false, brokenAt: i, total: lines.length };
    prev = hash!;
  }
  return { ok: true, total: lines.length };
}

export async function read(limit = 50): Promise<AuditEntry[]> {
  if (!(await exists(AUDIT_LOG))) return [];
  const lines = (await readFile(AUDIT_LOG, "utf8")).trim().split("\n");
  return lines.slice(-limit).map((l) => JSON.parse(l) as AuditEntry);
}
