import { appendFile, mkdir, readFile, rename, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Op } from "../types.ts";
import { ONMAC_DIR, exists } from "./snapshot.ts";

const TX_DIR = join(ONMAC_DIR, "tx");

/** 앱 객체(캘린더 이벤트 등) 삭제와 설정 원복은 tools 계층이 주입한다. */
export interface InverseHandlers {
  deleteAppObject?: (app: string, uid: string) => Promise<void>;
  restoreSetting?: (key: string, value: string) => Promise<void>;
}

/**
 * 한 턴의 모든 파일 조작을 하나로 묶는 단위.
 *
 * "Desktop 정리" 처럼 파일 40개를 건드리는 작업이 30번째에서 실패하면
 * 29개만 되돌아간 어중간한 상태가 최악이다. 전부 되돌리거나 전부 유지한다.
 */
export class Transaction {
  readonly id: string;
  private ops: Op[] = [];
  private readonly journal: string;
  private readonly inverse: InverseHandlers;
  private settled = false;

  private constructor(id: string, inverse: InverseHandlers) {
    this.id = id;
    this.inverse = inverse;
    this.journal = join(TX_DIR, id, "journal.jsonl");
  }

  static async begin(label: string, inverse: InverseHandlers = {}): Promise<Transaction> {
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}`;
    const tx = new Transaction(id, inverse);
    await mkdir(join(TX_DIR, id), { recursive: true });
    await appendFile(tx.journal, JSON.stringify({ kind: "_meta", label, ts: Date.now() }) + "\n");
    return tx;
  }

  /**
   * 연산 기록. 실제 파일 조작보다 **먼저** 호출해야 한다 (write-ahead).
   * 조작 직후에 기록하면 그 사이 프로세스가 죽었을 때 복구 정보가 사라진다.
   */
  async record(op: Op): Promise<void> {
    this.ops.push(op);
    await appendFile(this.journal, JSON.stringify(op) + "\n");
  }

  async commit(): Promise<void> {
    this.settled = true;
    await appendFile(this.journal, JSON.stringify({ kind: "_commit", ts: Date.now() }) + "\n");
  }

  async rollback(): Promise<string[]> {
    const undone = await applyInverse(this.ops, this.inverse);
    this.settled = true;
    await appendFile(this.journal, JSON.stringify({ kind: "_rollback", ts: Date.now() }) + "\n");
    return undone;
  }

  get isSettled(): boolean {
    return this.settled;
  }

  get opCount(): number {
    return this.ops.length;
  }
}

/**
 * 역연산을 **역순으로** 수행한다.
 * 순서를 지키지 않으면 "A를 B로 옮기고 B를 C로 옮김" 같은 연쇄가 복구되지 않는다.
 */
export async function applyInverse(ops: Op[], inverse: InverseHandlers): Promise<string[]> {
  const log: string[] = [];
  for (const op of [...ops].reverse()) {
    switch (op.kind) {
      case "create":
        if (await exists(op.path)) await rm(op.path, { recursive: true, force: true });
        log.push(`생성 취소: ${op.path}`);
        break;
      case "modify":
        await rename(op.snap, op.path);
        log.push(`내용 복원: ${op.path}`);
        break;
      case "move":
        await rename(op.to, op.from);
        log.push(`이동 취소: ${op.to} → ${op.from}`);
        break;
      case "delete":
        await rename(op.trash, op.path);
        log.push(`삭제 취소: ${op.path}`);
        break;
      case "appAdd":
        if (!inverse.deleteAppObject) throw new Error(`앱 객체 삭제 핸들러 미등록: ${op.app}`);
        await inverse.deleteAppObject(op.app, op.uid);
        log.push(`${op.app} 객체 제거: ${op.uid}`);
        break;
      case "settingChange":
        if (!inverse.restoreSetting) throw new Error(`설정 복원 핸들러 미등록: ${op.key}`);
        await inverse.restoreSetting(op.key, op.before);
        log.push(`설정 복원: ${op.key} = ${op.before}`);
        break;
      default: {
        // Op 에 새 종류를 추가하고 역연산을 빼먹으면 여기서 컴파일이 실패한다.
        const _exhaustive: never = op;
        throw new Error(`미처리 op: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }
  return log;
}

export interface TxSummary {
  id: string;
  label: string;
  ts: number;
  opCount: number;
  state: "committed" | "rolledback" | "open";
}

/** `onmac history` 용. 저널을 읽어 트랜잭션 목록을 만든다. */
export async function listTransactions(): Promise<TxSummary[]> {
  if (!(await exists(TX_DIR))) return [];
  const out: TxSummary[] = [];
  for (const id of await readdir(TX_DIR)) {
    const lines = (await readFile(join(TX_DIR, id, "journal.jsonl"), "utf8")).trim().split("\n");
    const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const meta = entries.find((e) => e["kind"] === "_meta");
    out.push({
      id,
      label: String(meta?.["label"] ?? "?"),
      ts: Number(meta?.["ts"] ?? 0),
      opCount: entries.filter((e) => !String(e["kind"]).startsWith("_")).length,
      state: entries.some((e) => e["kind"] === "_rollback")
        ? "rolledback"
        : entries.some((e) => e["kind"] === "_commit")
          ? "committed"
          : "open",
    });
  }
  return out.sort((a, b) => b.ts - a.ts);
}

/** `onmac undo [--tx id]`. 지정이 없으면 가장 최근 커밋된 트랜잭션을 되돌린다. */
export async function undo(
  txId: string | undefined,
  inverse: InverseHandlers,
): Promise<{ txId: string; log: string[] }> {
  const target = txId ?? (await listTransactions()).find((t) => t.state === "committed")?.id;
  if (!target) throw new Error("되돌릴 트랜잭션이 없습니다.");

  const lines = (await readFile(join(TX_DIR, target, "journal.jsonl"), "utf8")).trim().split("\n");
  const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  if (entries.some((e) => e["kind"] === "_rollback")) {
    throw new Error(`이미 되돌려진 트랜잭션입니다: ${target}`);
  }
  const ops = entries.filter((e) => !String(e["kind"]).startsWith("_")) as unknown as Op[];
  const log = await applyInverse(ops, inverse);
  await appendFile(join(TX_DIR, target, "journal.jsonl"), JSON.stringify({ kind: "_rollback", ts: Date.now() }) + "\n");
  return { txId: target, log };
}
