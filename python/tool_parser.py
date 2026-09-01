"""
Qwen 계열 모델의 툴 호출 출력 파서.

mlx 를 임포트하지 않으므로 모델 없이 단독 테스트가 가능하다 (tests/test_parser.py).
"""

import json
import re

# Qwen3.8 은 두 가지 형태로 툴 호출을 뱉는다. 둘 다 받는다.
#   (A) <tool_call><function=NAME><parameter=KEY>VALUE</parameter></function></tool_call>
#   (B) <tool_call>{"name": ..., "arguments": {...}}</tool_call>
# 닫는 태그는 선택으로 둔다 — max_tokens 에 걸려 잘린 출력도 살려내야 하기 때문이다.
TOOL_BLOCK_RE = re.compile(r"<tool_call>(.*?)(?:</tool_call>|$)", re.DOTALL)
FUNCTION_RE = re.compile(r"<function=([^>\s]+)\s*>(.*?)(?:</function>|$)", re.DOTALL)
PARAM_RE = re.compile(r"<parameter=([^>\s]+)\s*>(.*?)(?:</parameter>|$)", re.DOTALL)
THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)


def _coerce(raw):
    """파라미터 값은 전부 문자열로 오므로 숫자/불리언/배열만 되돌린다."""
    s = raw.strip()
    if s in ("true", "false"):
        return s == "true"
    if s and s[0] in "-0123456789[{":
        try:
            return json.loads(s)
        except json.JSONDecodeError:
            return s
    return s


def parse_tool_calls(text):
    calls = []
    for block in TOOL_BLOCK_RE.finditer(text):
        body = block.group(1).strip()

        if body.startswith("{"):  # (B) JSON 형식
            try:
                obj = json.loads(body)
                calls.append({"name": obj.get("name"), "args": obj.get("arguments", obj.get("args", {}))})
                continue
            except json.JSONDecodeError:
                pass  # 깨진 JSON 이면 XML 파싱을 시도해보고, 그것도 실패하면 버린다

        for fn in FUNCTION_RE.finditer(body):  # (A) XML 형식
            args = {k: _coerce(v) for k, v in PARAM_RE.findall(fn.group(2))}
            calls.append({"name": fn.group(1).strip(), "args": args})
    return calls


def strip_noise(text):
    """thinking 블록과 툴 호출 마크업을 걷어내고 사용자에게 보일 본문만 남긴다."""
    body = TOOL_BLOCK_RE.sub("", THINK_RE.sub("", text))
    # 여는 <think> 없이 </think> 만 남는 경우가 있다 (템플릿이 여는 태그를 프리필한 경우)
    if "</think>" in body:
        body = body.split("</think>", 1)[1]
    return body.strip()
