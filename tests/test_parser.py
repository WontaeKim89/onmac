"""
사이드카 툴 호출 파서 테스트. 모델 없이 돈다.

    python3 tests/test_parser.py
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))

from tool_parser import parse_tool_calls, strip_noise  # noqa: E402


def test_xml_form():
    text = """<think>어디를 볼지 고민</think>
<tool_call>
<function=list_dir>
<parameter=path>
~/Desktop
</parameter>
</function>
</tool_call>"""
    calls = parse_tool_calls(text)
    assert calls == [{"name": "list_dir", "args": {"path": "~/Desktop"}}], calls
    assert strip_noise(text) == ""


def test_json_form():
    text = '<tool_call>{"name": "set_volume", "arguments": {"level": 30}}</tool_call>'
    assert parse_tool_calls(text) == [{"name": "set_volume", "args": {"level": 30}}]


def test_multiple_params():
    text = "<tool_call><function=move_file><parameter=from>/a</parameter><parameter=to>/b</parameter></function></tool_call>"
    assert parse_tool_calls(text)[0]["args"] == {"from": "/a", "to": "/b"}


def test_truncated_output_still_parses():
    """max_tokens 에 걸려 닫는 태그 없이 잘린 경우에도 호출을 살려낸다."""
    text = "<tool_call>\n<function=delete_file>\n<parameter=path>\n/tmp/a.txt"
    assert parse_tool_calls(text) == [{"name": "delete_file", "args": {"path": "/tmp/a.txt"}}]


def test_boolean_and_number_coercion():
    text = "<tool_call><function=set_dark_mode><parameter=enabled>true</parameter></function></tool_call>"
    assert parse_tool_calls(text)[0]["args"]["enabled"] is True


def test_dangling_think_close_tag():
    """템플릿이 <think> 를 프리필하면 여는 태그 없이 </think> 만 나온다."""
    assert strip_noise("사고과정</think>실제 답변.") == "실제 답변."


def test_plain_answer_untouched():
    assert parse_tool_calls("Desktop 에 파일 54개 있습니다.") == []
    assert strip_noise("Desktop 에 파일 54개 있습니다.") == "Desktop 에 파일 54개 있습니다."


def test_malformed_json_falls_back_without_crashing():
    assert parse_tool_calls('<tool_call>{"name": broken</tool_call>') == []


if __name__ == "__main__":
    passed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            passed += 1
            print(f"  ok  {name}")
    print(f"\n{passed} passed")
