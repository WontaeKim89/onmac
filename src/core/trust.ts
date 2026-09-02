import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolSpec } from "../types.ts";
import { ONMAC_DIR, atomicWrite, exists } from "./snapshot.ts";
import * as audit from "./audit.ts";

/**
 * 신뢰 장부 — "행동이 곧 설정" 모델의 심장.
 *
 * 사용자는 규칙을 설계하지 않는다. 평소처럼 승인하고, 마음에 안 들면 되돌릴 뿐이다.
 * 이 장부가 그 행동을 집계해서, 실적이 쌓인 작업 유형에 대해 시스템이 먼저
 * "이제 안 물어봐도 될까요?" 하고 승급을 신청한다. 결정은 항상 사람이 한다.
 *
 * 불변식 — 어떤 실적으로도 깨지지 않는다:
 *   - deny 경로 차단은 별개 층(policy)이다. 이 장부는 policy 를 읽지도 쓰지도 못한다.
 *   - ask_always(삭제)와 R3(복구 불가)는 승급 대상이 아니다. isAuto 가 아니라
 *     eligible 단계에서 걸러지므로, 장부 파일을 손으로 고쳐도 executor 게이트가 재확인한다.
 *   - 되돌리기 1회 = 그 유형 즉시 강등. 강등에 확인 절차는 없다 (신뢰 회수는 즉시여야 한다).
 */

export interface CategoryStat {
  approvals: number;
  denials: number;
  undos: number;
  mode: "ask" | "auto";
  /** 사용자가 승급 제안을 거절한 유형은 다시 조르지 않는다. */
  declinedProposal?: boolean;
}

interface TrustStore {
  version: 1;
  categories: Record<string, CategoryStat>;
}

const TRUST_PATH = join(ONMAC_DIR, "trust.json");

const EMPTY: CategoryStat = { approvals: 0, denials: 0, undos: 0, mode: "ask" };

export class TrustLedger {
  private store: TrustStore = { version: 1, categories: {} };
  private loaded = false;
  private readonly promoteAfter: number;

  constructor(promoteAfter: number) {
    this.promoteAfter = promoteAfter;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (await exists(TRUST_PATH)) {
      try {
        this.store = JSON.parse(await readFile(TRUST_PATH, "utf8")) as TrustStore;
      } catch {
        // 깨진 장부는 빈 장부로 취급한다. 신뢰를 잃는 방향의 실패라 안전하다.
        this.store = { version: 1, categories: {} };
      }
    }
  }

  private async save(): Promise<void> {
    await atomicWrite(TRUST_PATH, JSON.stringify(this.store, null, 2));
  }

  /**
   * 카테고리 키. 지금은 툴 이름 하나다.
   * ponytail: 툴 × 대상 폴더로 세분화하는 건 어떤 경계가 사용자 기대와 맞는지
   * 데이터가 쌓인 뒤에 정한다. 지금 세분화하면 승급이 영영 안 온다.
   */
  private key(toolName: string): string {
    return toolName;
  }

  private stat(toolName: string): CategoryStat {
    const k = this.key(toolName);
    return (this.store.categories[k] ??= { ...EMPTY });
  }

  /** 승인/거절 기록. consent 를 거친 모든 결정이 여기 쌓인다. */
  async recordDecision(toolName: string, decision: "approved" | "denied"): Promise<void> {
    await this.load();
    const s = this.stat(toolName);
    if (decision === "approved") s.approvals++;
    else s.denials++;
    await this.save();
  }

  /**
   * 이 유형이 자동 실행 위임 상태인가.
   * 게이트 쪽에서 ask_always/R3 를 재확인하므로 여기서는 mode 만 본다.
   */
  async isAuto(toolName: string): Promise<boolean> {
    await this.load();
    return this.store.categories[this.key(toolName)]?.mode === "auto";
  }

  /**
   * 승급 자격이 있는 유형들. 시스템이 제안만 하고 결정은 사용자가 한다.
   * 자격: 승인 임계 도달 + 되돌림 0 + 아직 ask + 제안 거절 이력 없음
   *      + 정책상 승급 가능한 성격(ask 이고, R1/R2 — 파일이든 설정이든 되돌릴 수 있는 것만).
   */
  async eligibleProposals(tools: ToolSpec[]): Promise<Array<{ tool: ToolSpec; stat: CategoryStat }>> {
    await this.load();
    const out: Array<{ tool: ToolSpec; stat: CategoryStat }> = [];
    for (const tool of tools) {
      if (tool.reversibility !== "R1" && tool.reversibility !== "R2") continue;
      const s = this.store.categories[this.key(tool.name)];
      if (!s || s.mode !== "ask" || s.declinedProposal) continue;
      if (s.undos > 0) continue;
      if (s.approvals < this.promoteAfter) continue;
      out.push({ tool, stat: { ...s } });
    }
    return out;
  }

  async promote(toolName: string): Promise<void> {
    await this.load();
    this.stat(toolName).mode = "auto";
    await this.save();
  }

  async declineProposal(toolName: string): Promise<void> {
    await this.load();
    this.stat(toolName).declinedProposal = true;
    await this.save();
  }

  /**
   * 되돌리기 = 신뢰 회수. 해당 트랜잭션에 참여한 모든 유형을 즉시 강등한다.
   * 어떤 툴이 참여했는지는 감사로그(txId 로 기록됨)에서 읽는다 — 장부의 원장은 항상 audit 이다.
   */
  async demoteForTx(txId: string): Promise<string[]> {
    await this.load();
    const entries = await audit.forTx(txId);
    const demoted: string[] = [];
    for (const toolName of new Set(entries.map((e) => e.tool))) {
      const s = this.stat(toolName);
      s.undos++;
      if (s.mode === "auto") demoted.push(toolName);
      s.mode = "ask";
      delete s.declinedProposal; // 사정이 바뀌었으니 나중에 다시 제안해도 된다
    }
    await this.save();
    return demoted;
  }

  /** "전부 다시 물어봐" — 모든 위임 즉시 해제. 통계는 남긴다 (이력은 사실이다). */
  async revokeAll(): Promise<number> {
    await this.load();
    let n = 0;
    for (const s of Object.values(this.store.categories)) {
      if (s.mode === "auto") n++;
      s.mode = "ask";
    }
    await this.save();
    return n;
  }

  async snapshot(): Promise<Record<string, CategoryStat>> {
    await this.load();
    return structuredClone(this.store.categories);
  }
}
