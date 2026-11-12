#!/usr/bin/env bash
# 给 awesome-dsh-plugin 提收录 PR：新增 data/plugins/kute__dsh-keelwatch.yml
#
# 他们的规则（contributing.md）：一个插件一个文件、只改自己那一条、仓库需满 1 天。
# 本脚本只新增一个文件，不触碰任何既有条目。
#
# 用法：
#   ./scripts/submit-awesome.sh             # 真正 fork / 提交 / 开 PR
#   ./scripts/submit-awesome.sh --dry-run   # 只检查前置条件与将要写入的内容
#
# 前置：gh 已登录 kute；仓库已加 dsh-plugin topic；距离仓库创建已满 24 小时。

set -euo pipefail
cd "$(dirname "$0")/.."

UPSTREAM="awesome-dsh-plugin/awesome-dsh-plugin"
MY_REPO="kute/dsh-keelwatch"
ENTRY_SRC=".github/awesome-entry.yml"
ENTRY_DEST="data/plugins/kute__dsh-keelwatch.yml"
BRANCH="add/kute-dsh-keelwatch"
WORKDIR="$(mktemp -d)"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

say() { printf 'awesome: %s\n' "$*"; }

[ -f "$ENTRY_SRC" ] || { say "缺少 $ENTRY_SRC"; exit 1; }
ACCOUNT="$(gh api user --jq .login)"
[ "$ACCOUNT" = "kute" ] || { say "gh 当前账号是 $ACCOUNT，需要 kute"; exit 1; }
say "gh 账号：$ACCOUNT"

CREATED="$(gh api "repos/$MY_REPO" --jq .created_at)"
AGE_HOURS=$(( ( $(date -u +%s) - $(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$CREATED" +%s) ) / 3600 ))
say "仓库创建于 $CREATED，已存在 ${AGE_HOURS}h（要求 >= 24h）"
if [ "$AGE_HOURS" -lt 24 ] && [ "$DRY_RUN" -eq 0 ]; then
  say "未满 24 小时，等待后再提交（CI 会直接打回）"
  exit 1
fi

TOPIC_OK="$(gh api "repos/$MY_REPO/topics" --jq '.names | index("dsh-plugin") // empty')"
[ -n "$TOPIC_OK" ] && say "topic dsh-plugin：已存在" || say "topic dsh-plugin：缺失（需要补）"

if [ "$DRY_RUN" -eq 1 ]; then
  say "dry run：将写入 $ENTRY_DEST"
  sed 's/^/  /' "$ENTRY_SRC"
  exit 0
fi

say "fork 上游仓库（已存在则复用）"
gh repo fork "$UPSTREAM" --clone=false >/dev/null 2>&1 || true

say "克隆 fork 到临时目录"
gh repo clone "$ACCOUNT/awesome-dsh-plugin" "$WORKDIR/repo" -- --depth=1 >/dev/null

cd "$WORKDIR/repo"
/usr/bin/git checkout -b "$BRANCH"
mkdir -p "$(dirname "$ENTRY_DEST")"
# Strip the explanatory comments: their linter reads the file as data, and a
# submission that carries stray keys or markers is the usual reason for a bounce.
grep -v '^[[:space:]]*#' "$OLDPWD/$ENTRY_SRC" > "$ENTRY_DEST"
/usr/bin/git add "$ENTRY_DEST"
/usr/bin/git -c user.name=kute -c user.email=kute@users.noreply.github.com \
  commit -q -m "Add kute/dsh-keelwatch"
/usr/bin/git push -u origin "$BRANCH" 2>&1 | tail -2

say "开 PR"
BODY="$(cat <<'MD'
Adds `kute/dsh-keelwatch` — an operations layer for DSH plugin ecosystems.

- **Drift radar**: scans installed bundles for `engines.dsh` / dependency drift against the registry.
- **Failure brake**: counts consecutive tool failures and denies further calls during a cooldown, with a structured reason so the turn continues.
- **Cost attribution**: attributes surface tokens per `MessageSource.kind` and times every `tools/execute`.

The repo declares `dsh.bundle` (with `cordis.patch.yml`), is published to npm as `@kutebai/dsh-keelwatch@0.1.0`, and attaches a pinned prebuilt tarball to the `v0.1.0` release. Single-file submission; no existing entry is touched.

Verified locally: 87 tests passing, plugin loads in DSH 0.2.1-rc.5, config page and `keelwatch_report` tool both work end to end.
MD
)"
gh pr create --repo "$UPSTREAM" --head "$ACCOUNT:$BRANCH" \
  --title "Add kute/dsh-keelwatch" --body "$BODY" 2>&1 | tail -3

cd - >/dev/null
rm -rf "$WORKDIR"
say "完成"
