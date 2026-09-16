#!/bin/bash
# Build src/ → lib/ with tsc. Dependency source (priority):
#   1. DSH_CHECKOUT (dsh 源码仓库，含 packages/ + vendor/) — 官方脚手架路径
#   2. DSH_INSTALL  （已安装的 @deepseek-ai/dsh 包树，默认 npm root -g）— 本机无 checkout 时
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── 定位 TypeScript 编译器 ──
if [ -f "$ROOT/node_modules/.bin/tsc" ]; then
  TSC="$ROOT/node_modules/.bin/tsc"
else
  TSC="$(command -v tsc || true)"
fi
if [ -z "$TSC" ]; then
  echo "build: tsc not found（先 npm install 装 devDependencies）" >&2
  exit 1
fi

link_dir() {
  local link="$1" target="$2"
  [ -e "$target" ] || { echo "build: dependency target missing: $target" >&2; exit 1; }
  mkdir -p "$(dirname "$link")"
  rm -rf "$link"
  ln -sfn "$(cd "$target" && pwd)" "$link"
}

echo "=== Linking build dependencies ==="
mkdir -p node_modules/@deepseek-ai

if [ -n "${DSH_CHECKOUT:-}" ] && [ -d "$DSH_CHECKOUT/packages" ]; then
  echo "checkout: $DSH_CHECKOUT"
  link_dir node_modules/@deepseek-ai/cordis "$DSH_CHECKOUT/vendor/cordis"
  link_dir node_modules/@deepseek-ai/schemastery "$DSH_CHECKOUT/vendor/schemastery"
  link_dir node_modules/@deepseek-ai/dsh-tools "$DSH_CHECKOUT/packages/core/tools"
elif [ -n "${DSH_INSTALL:-}" ] || [ -d "$HOME/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis" ]; then
  INST="${DSH_INSTALL:-$HOME/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules}"
  echo "install-tree: $INST"
  link_dir node_modules/@deepseek-ai/cordis "$INST/@deepseek-ai/cordis"
  link_dir node_modules/@deepseek-ai/schemastery "$INST/@deepseek-ai/schemastery"
  link_dir node_modules/@deepseek-ai/dsh-tools "$INST/@deepseek-ai/dsh-tools"
else
  echo "build: cannot locate dsh checkout or installed tree (set DSH_CHECKOUT or DSH_INSTALL)" >&2
  exit 1
fi
# @types/node：优先本包 devDependencies，其次 dsh 安装树
if [ ! -d node_modules/@types/node ]; then
  for cand in "$ROOT/node_modules/@types/node" "$HOME/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@types/node"; do
    if [ -d "$cand" ]; then link_dir node_modules/@types/node "$cand"; break; fi
  done
fi

echo "=== Compiling src → lib ==="
"$TSC" -p tsconfig.json

# client bundle（tsdown）——src/client 存在时必须编，否则运行时拿旧 bundle（rev URL 缓存）
if [ -d "$ROOT/src/client" ]; then
  echo "=== Building client (tsdown) ==="
  if [ -x "$ROOT/node_modules/.bin/tsdown" ]; then
    (cd "$ROOT" && node_modules/.bin/tsdown >/dev/null)
  elif command -v npx >/dev/null 2>&1; then
    (cd "$ROOT" && npx tsdown >/dev/null)
  else
    echo "build: tsdown not found（client 未编译——运行 npm run build:client）" >&2
  fi
fi
echo "=== Build complete ==="
