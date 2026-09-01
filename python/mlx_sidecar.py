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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mlx_vlm import load, generate
from mlx_vlm.prompt_utils import apply_chat_template
from mlx_vlm.utils import load_config

from tool_parser import parse_tool_calls, strip_noise


def build_prompt(processor, config, messages, tools, n_images):
    """
    이미지가 없으면 tokenizer 의 chat template 을 직접 쓴다 — Qwen 템플릿이 tools 인자를
    받아 툴 호출 규약을 알아서 주입해준다. 이미지가 있으면 mlx_vlm 경로를 타야 한다.
    """
    if n_images == 0:
        tok = getattr(processor, "tokenizer", processor)
        return tok.apply_chat_template(
            messages, tools=tools or None, add_generation_prompt=True, tokenize=False
        )
    return apply_chat_template(processor, config, messages, num_images=n_images)


def main():
    model_path = sys.argv[1]
    model, processor = load(model_path)
    config = load_config(model_path)
    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            images = req.get("images") or []
            prompt = build_prompt(processor, config, req["messages"], req.get("tools"), len(images))
            result = generate(
                model,
                processor,
                prompt,
                image=images or None,
                max_tokens=req.get("max_tokens", 2048),
                temperature=req.get("temperature", 0.6),
                # native 262k 를 그대로 열면 KV 캐시가 통합메모리를 삼킨다.
                max_kv_size=req.get("max_kv_size", 32768),
                verbose=False,
            )
            text = result if isinstance(result, str) else getattr(result, "text", str(result))
            print(
                json.dumps(
                    {"content": strip_noise(text), "tool_calls": parse_tool_calls(text)},
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception as e:  # 사이드카가 죽으면 17GB 를 다시 올려야 한다. 반드시 살려둔다.
            print(json.dumps({"error": f"{type(e).__name__}: {e}"}), flush=True)


if __name__ == "__main__":
    main()
