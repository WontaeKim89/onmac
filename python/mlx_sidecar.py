"""
MLX 사이드카 — Apple Silicon 전용 백엔드.

stdin 으로 JSON 한 줄을 받고 stdout 으로 JSON 한 줄을 돌려주는 단순한 프로토콜.
op 필드로 작업을 고른다. 없으면 대화 생성이다.

  {"op":"warmup"}                          → VLM(17GB) 적재
  {"messages":[...], "tools":[...]}        → 대화 생성 (стream 지원)
  {"op":"embed","texts":[...],"kind":"query"|"passage"} → 임베딩 벡터
  {"op":"describe","image":"/path.png"}    → 이미지 한 장 서술 (색인용)

모델은 전부 지연 적재다 — 임베딩만 쓰는 색인 작업이 17GB VLM 적재를
기다릴 이유가 없다. 네트워크 호출은 이 파일 어디에도 없다.
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from tool_parser import parse_tool_calls, strip_noise

_VLM = None  # (model, processor, config)
_VLM_PATH = sys.argv[1]
_EMB = None  # (model, tokenizer)


def vlm():
    global _VLM
    if _VLM is None:
        from mlx_vlm import load
        from mlx_vlm.utils import load_config

        model, processor = load(_VLM_PATH)
        _VLM = (model, processor, load_config(_VLM_PATH))
    return _VLM


def set_model(path):
    """모델 교체. 48GB 에 27B 두 개는 못 올린다 — 반드시 내리고 올린다.

    가중치 파일은 macOS 페이지 캐시에 남아 있으므로, 최근에 쓰던 모델로
    되돌아오는 교체는 디스크가 아니라 RAM 에서 읽어 훨씬 빠르다.
    """
    global _VLM, _VLM_PATH
    _VLM = None
    _VLM_PATH = path
    import gc

    gc.collect()
    try:
        import mlx.core as mx

        mx.clear_cache()
    except Exception:
        pass


def emb():
    global _EMB
    if _EMB is None:
        from mlx_embeddings import load

        _EMB = load(sys.argv[2])
    return _EMB


def make_apc():
    """프롬프트 캐시 — 매 턴 동일한 시스템+툴 접두사(800토큰, 7초) 재계산을 없앤다."""
    try:
        from mlx_vlm.apc import APCManager

        return APCManager(num_blocks=4096, block_size=16)
    except Exception as e:
        print(json.dumps({"warn": f"프롬프트 캐시 비활성: {e}"}), flush=True)
        return None


def build_prompt(processor, config, messages, tools, n_images, thinking=False):
    """thinking 을 끄면 사고 과정 토큰이 사라진다. 실측 12.0s → 8.3s."""
    from mlx_vlm.prompt_utils import apply_chat_template

    if n_images == 0:
        tok = getattr(processor, "tokenizer", processor)
        try:
            return tok.apply_chat_template(
                messages, tools=tools or None, add_generation_prompt=True,
                tokenize=False, enable_thinking=thinking,
            )
        except TypeError:
            return tok.apply_chat_template(
                messages, tools=tools or None, add_generation_prompt=True, tokenize=False
            )
    return apply_chat_template(processor, config, messages, num_images=n_images)


def op_generate(req, apc):
    from mlx_vlm import generate, stream_generate

    model, processor, config = vlm()
    images = req.get("images") or []
    prompt = build_prompt(
        processor, config, req["messages"], req.get("tools"), len(images), req.get("thinking", False)
    )
    kwargs = {
        "max_tokens": req.get("max_tokens", 2048),
        "temperature": req.get("temperature", 0.6),
        "max_kv_size": req.get("max_kv_size", 32768),
    }
    # 이미지가 섞이면 접두사가 매번 달라져 캐시가 손해다. 텍스트 턴에만 쓴다.
    if apc is not None and not images:
        kwargs["apc_manager"] = apc
        kwargs["apc_tenant"] = "onmac"

    t0 = time.time()
    if req.get("stream"):
        parts, last = [], None
        for chunk in stream_generate(model, processor, prompt, image=images or None, **kwargs):
            piece = getattr(chunk, "text", "")
            if piece:
                parts.append(piece)
                print(json.dumps({"delta": piece}, ensure_ascii=False), flush=True)
            last = chunk
        text, result = "".join(parts), last
    else:
        result = generate(model, processor, prompt, image=images or None, verbose=False, **kwargs)
        text = result if isinstance(result, str) else getattr(result, "text", str(result))

    return {
        "content": strip_noise(text),
        "tool_calls": parse_tool_calls(text),
        "stats": {
            "wall_s": round(time.time() - t0, 1),
            "prompt_tokens": getattr(result, "prompt_tokens", None),
            "gen_tokens": getattr(result, "generation_tokens", None),
            "cached_tokens": getattr(result, "cached_tokens", None),
            "gen_tps": round(getattr(result, "generation_tps", 0) or 0, 1),
        },
    }


def op_embed(req):
    from mlx_embeddings import generate as embed_generate

    model, tokenizer = emb()
    kind = req.get("kind", "passage")
    # e5 계열은 query:/passage: 접두사로 학습됐다. 빼면 유사도가 미묘하게 무너진다.
    texts = [f"{kind}: {t}" for t in req["texts"]]
    out = embed_generate(model, tokenizer, texts=texts)
    return {"vectors": out.text_embeds.tolist()}


DESCRIBE_PROMPT = (
    "이 이미지를 검색 색인용으로 서술하라. 다음을 반드시 포함:\n"
    "1) 한 줄 요약  2) 화면/사진 속 보이는 텍스트를 그대로 (에러 메시지, 제목, 코드 등)\n"
    "3) 어떤 종류의 화면인지 (터미널, 브라우저, 문서, 사진 등)\n"
    "설명 외 다른 말은 하지 마라."
)


def op_describe(req):
    from mlx_vlm import generate
    from mlx_vlm.prompt_utils import apply_chat_template

    model, processor, config = vlm()
    messages = [{"role": "user", "content": DESCRIBE_PROMPT}]
    prompt = apply_chat_template(processor, config, messages, num_images=1)
    result = generate(
        model, processor, prompt, image=[req["image"]],
        max_tokens=req.get("max_tokens", 400), temperature=0.3, max_kv_size=8192, verbose=False,
    )
    text = result if isinstance(result, str) else getattr(result, "text", str(result))
    return {"content": strip_noise(text)}


def main():
    apc = make_apc()
    # 아무것도 적재하지 않고 즉시 준비 신호 — 무엇을 올릴지는 첫 요청이 정한다
    print(json.dumps({"ready": True, "apc": apc is not None}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            op = req.get("op")
            if op == "warmup":
                vlm()
                out = {"ready": True, "model": _VLM_PATH}
            elif op == "set_model":
                set_model(req["path"])
                out = {"ok": True}
            elif op == "embed":
                out = op_embed(req)
            elif op == "describe":
                out = op_describe(req)
            else:
                out = op_generate(req, apc)
            print(json.dumps(out, ensure_ascii=False), flush=True)
        except Exception as e:  # 사이드카가 죽으면 모델을 다시 올려야 한다. 반드시 살려둔다.
            print(json.dumps({"error": f"{type(e).__name__}: {e}"}), flush=True)


if __name__ == "__main__":
    main()
