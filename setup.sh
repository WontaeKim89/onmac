#!/bin/bash
# onmac 설치 스크립트 — Apple Silicon Mac 전용.
# 기본 경로는 파이썬을 요구하지 않는다. MLX 백엔드를 쓸 때만 --mlx 를 붙인다.
set -euo pipefail
cd "$(dirname "$0")"

[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || {
  echo "onmac 은 Apple Silicon Mac 전용입니다."; exit 1;
}

MEM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
(( MEM_GB >= 16 )) || { echo "통합메모리 ${MEM_GB}GB — 최소 16GB 필요."; exit 1; }
(( MEM_GB >= 24 )) || echo "경고: ${MEM_GB}GB 에서는 27B 대신 8B 모델을 권장합니다."

command -v node >/dev/null || { echo "Node.js 22.6 이상이 필요합니다: brew install node"; exit 1; }

echo "==> npm 의존성"
npm install --no-audit --no-fund

echo "==> 빌드"
npm run build

if [[ "${1:-}" == "--mlx" ]]; then
  echo "==> MLX 백엔드 (파이썬 사이드카)"
  command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
  uv venv --python 3.12
  uv pip install "mlx-vlm>=0.6.8" huggingface_hub
  ./.venv/bin/python -c "import mlx.core as mx; assert mx.metal.is_available(); print('Metal OK')"
  hf download mlx-community/Qwen3.8-27B-4bit --local-dir models/Qwen3.8-27B-4bit
fi

[[ -f onmac.toml ]] || { cp onmac.example.toml onmac.toml; echo "==> onmac.toml 생성됨"; }

cat <<'EOF'

설치 완료.

  1) onmac.toml 의 [roots] allow 를 본인 환경에 맞게 수정하십시오.
     허용 경로를 적기 전까지 onmac 은 아무 파일도 건드리지 않습니다.
  2) 모델 파일 경로를 [llm.llamacpp] 또는 [llm.mlx] 에 지정하십시오.
  3) 실행: npx onmac

EOF
