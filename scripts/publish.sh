#!/usr/bin/env bash
# 一键发布：npm publish → 索引切到 npm 源 → 推送 → 更新 Release 附件
#
# 前提：本机已完成 npm 认证，且 token 允许发布（两种方式之一）
#   1) granular access token，创建时勾选 "Bypass two-factor authentication"
#   2) 账号启用 2FA 后，用 npm publish --otp=<验证码>（本脚本支持 --otp 透传）
#
# 用法：
#   ./scripts/publish.sh                 # 用现有 token 发布
#   ./scripts/publish.sh --otp 123456    # 带一次性验证码发布
#   ./scripts/publish.sh --dry-run       # 只跑校验与打包，不发布

set -euo pipefail
cd "$(dirname "$0")/.."

REGISTRY="https://registry.npmjs.org"
PKG_NAME="$(node -p "require('./package.json').name")"
PKG_VERSION="$(node -p "require('./package.json').version")"
DRY_RUN=0
OTP=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --otp) OTP="${2:-}"; shift 2 ;;
    *) echo "publish: 未知参数 $1" >&2; exit 2 ;;
  esac
done

say() { printf 'publish: %s\n' "$*"; }

say "包 $PKG_NAME@$PKG_VERSION → $REGISTRY"

if [ "$DRY_RUN" -eq 0 ]; then
  ACCOUNT="$(npm whoami --registry="$REGISTRY" 2>/dev/null || true)"
  if [ -z "$ACCOUNT" ]; then
    say "未登录 npm。先执行：npm login --registry=$REGISTRY"
    exit 1
  fi
  say "登录账号：$ACCOUNT"
fi

# The index is regenerated BEFORE the test run: market-index.test.mjs asserts it
# matches package.json, so a version bump would otherwise fail its own release.
say "生成索引（先于测试，避免版本号不一致）"
node scripts/market-index.mjs --source npm --out docs/index.json

say "构建 + 测试"
pnpm build
node --test test/*.test.mjs | tail -3

if [ "$DRY_RUN" -eq 1 ]; then
  say "dry run：只打包"
  pnpm pack
  exit 0
fi

say "发布到 npm"
if [ -n "$OTP" ]; then
  npm publish --registry="$REGISTRY" --access public --otp="$OTP"
else
  npm publish --registry="$REGISTRY" --access public
fi

say "复核索引"
node scripts/market-index.mjs --check
/usr/bin/git add docs/index.json package.json pnpm-lock.yaml
if ! /usr/bin/git diff --cached --quiet; then
  /usr/bin/git commit -m "chore(market): 索引切换到 npm 源（$PKG_NAME@$PKG_VERSION）"
  /usr/bin/git push origin main
else
  say "索引无变化，跳过提交"
fi

say "更新 GitHub Release 附件"
# pnpm names a scoped tarball by flattening the scope: @kutebai/x -> kutebai-x
TARBALL="$(printf '%s-%s.tgz' "${PKG_NAME#@}" "$PKG_VERSION" | tr '/' '-')"
if [ -f "$TARBALL" ]; then
  gh release upload "v$PKG_VERSION" "$TARBALL" --repo kute/dsh-keelwatch --clobber
else
  say "未找到 $TARBALL，跳过附件更新（先执行 pnpm pack）"
fi

say "完成：https://www.npmjs.com/package/$PKG_NAME"
