/**
 * 엔드투엔드 연기 테스트.
 *
 * 모델을 실제로 올려서 "툴 호출 → 정책 통과 → 실행 → 답변" 전 경로가 도는지 확인한다.
 * list_dir 은 정책상 allow 라서 사람 개입 없이 자동으로 끝난다.
 */
import { load } from "../src/core/config.ts";
import { Agent, buildBackend } from "../src/agent.ts";
import { AutoDenyConsent } from "../src/core/consent.ts";

const t0 = Date.now();
const cfg = await load(new URL("..", import.meta.url).pathname);
console.log(`backend=${cfg.llm.backend} model=${cfg.llm.mlx.modelPath}`);

const agent = new Agent(cfg, buildBackend(cfg), new AutoDenyConsent());
console.log(`툴 ${agent.toolNames.length}개: ${agent.toolNames.join(", ")}`);

const q = "~/Desktop 디렉토리에 파일이 몇 개나 있는지 확인하고 한 줄로 알려줘.";
console.log(`\n> ${q}\n`);
const answer = await agent.ask(q);
console.log(answer);
console.log(`\n소요 ${((Date.now() - t0) / 1000).toFixed(1)}초`);

await agent.close();
process.exit(0);
