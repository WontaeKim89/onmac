"""
MLX 사이드카 — Apple Silicon 전용 백엔드.

stdin 으로 JSON 한 줄을 받고 stdout 으로 JSON 한 줄을 돌려주는 단순한 프로토콜.
모델을 프로세스에 한 번만 올려두고 계속 재사용한다 (17GB 를 매번 로드할 수 없다).

요청:  {"messages": [...], "tools": [...], "images": ["/path.png"], "max_tokens": 2048}
응답:  {"content": "...", "tool_calls": [{"name": "...", "args": {...}}]}

네트워크 호출은 이 파일 어디에도 없다. 그것이 이 프로젝트의 요구사항이다.
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mlx_vlm import load, generate
from mlx_vlm.prompt_utils import apply_chat_template
from mlx_vlm.utils import load_config

from tool_parser import parse_tool_calls, strip_noise


def build_prompt(processor, config, messages, tools, n_images, thinking=False):
    """
    이미지가 없으면 tokenizer 의 chat template 을 직접 쓴다 — Qwen 템플릿이 tools 인자를
    받아 툴 호출 규약을 알아서 주입해준다. 이미지가 있으면 mlx_vlm 경로를 타야 한다.

    thinking 을 끄면 사고 과정 토큰이 사라진다. 실측으로 12.0s → 8.3s.
    툴을 고르는 정도의 판단에는 사고 과정이 필요하지 않았다.
    """
    if n_images == 0:
        tok = getattr(processor, "tokenizer", processor)
        try:
            return tok.apply_chat_template(
                messages, tools=tools or None, add_generation_prompt=True,
                tokenize=False, enable_thinking=thinking,
            )
        except TypeError:  # enable_thinking 을 모르는 템플릿
            return tok.apply_chat_template(
                messages, tools=tools or None, add_generation_prompt=True, tokenize=False
            )
    return apply_chat_template(processor, config, messages, num_images=n_images)


def make_apc():
    """
    자동 프롬프트 캐시.

    측정해보면 이 에이전트의 시간은 답변 생성이 아니라 프롬프트 처리에 간다.
    시스템 프롬프트 + 툴 스키마 11개가 800토큰이고, prefill 이 약 120 tok/s 라
    매 턴 7초가 같은 내용을 다시 계산하는 데 쓰인다. 접두사가 매 턴 동일하므로
    블록 단위로 재사용하면 그 시간이 사라진다.
    """
    try:
        from mlx_vlm.apc import APCManager

        return APCManager(num_blocks=4096, block_size=16)
    except Exception as e:  # 버전에 없으면 캐시 없이 동작한다 — 느릴 뿐 틀리지 않는다
        print(json.dumps({"warn": f"프롬프트 캐시 비활성: {e}"}), flush=True)
        return None


def main():
    model_path = sys.argv[1]
    model, processor = load(model_path)
    config = load_config(model_path)
    apc = make_apc()
    print(json.dumps({"ready": True, "apc": apc is not None}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            images = req.get("images") or []
            prompt = build_prompt(
                processor, config, req["messages"], req.get("tools"),
                len(images), req.get("thinking", False),
            )
            kwargs = {
                "max_tokens": req.get("max_tokens", 2048),
                "temperature": req.get("temperature", 0.6),
                # native 262k 를 그대로 열면 KV 캐시가 통합메모리를 삼킨다.
                "max_kv_size": req.get("max_kv_size", 32768),
            }
            # 이미지가 섞이면 접두사가 매번 달라져 캐시가 오히려 손해다. 텍스트 턴에만 쓴다.
            if apc is not None and not images:
                kwargs["apc_manager"] = apc
                kwargs["apc_tenant"] = "onmac"

            t0 = time.time()
            result = generate(model, processor, prompt, image=images or None, verbose=False, **kwargs)
            text = result if isinstance(result, str) else getattr(result, "text", str(result))

            print(
                json.dumps(
                    {
                        "content": strip_noise(text),
                        "tool_calls": parse_tool_calls(text),
                        "stats": {
                            "wall_s": round(time.time() - t0, 1),
                            "prompt_tokens": getattr(result, "prompt_tokens", None),
                            "gen_tokens": getattr(result, "generation_tokens", None),
                            "cached_tokens": getattr(result, "cached_tokens", None),
                            "gen_tps": round(getattr(result, "generation_tps", 0) or 0, 1),
                        },
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception as e:  # 사이드카가 죽으면 17GB 를 다시 올려야 한다. 반드시 살려둔다.
            print(json.dumps({"error": f"{type(e).__name__}: {e}"}), flush=True)


if __name__ == "__main__":
    main()
