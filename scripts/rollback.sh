#!/usr/bin/env bash
# keelwatch 回滚 / 急救工具
#
# 设计前提：永远不要把这个插件装进正在使用的主 profile（web）。验证一律用独立
# profile。但即使真的装错了，这个脚本也能在 DSH 完全启动不了的情况下工作——它
# 只用 bash + python3，不依赖 dsh 命令行能否跑起来。
#
# 用法：
#   ./scripts/rollback.sh status  [profile]   查看该 profile 是否挂了 keelwatch
#   ./scripts/rollback.sh disable [profile]   在 profile patch 里禁用 keelwatch 行（可逆、最快）
#   ./scripts/rollback.sh remove  [profile]   卸载包（走 dsh plugin remove，失败则直接改清单）
#   ./scripts/rollback.sh purge   [profile]   删除整个验证 profile 目录（仅限非 web/desktop）
#
# profile 省略时默认 keelwatch-verify。

set -euo pipefail

PKG="@kute/dsh-keelwatch"
ROW_ID="keelwatch"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
ACTION="${1:-status}"
PROFILE="${2:-keelwatch-verify}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"

die() { printf 'rollback: %s\n' "$*" >&2; exit 1; }
info() { printf 'rollback: %s\n' "$*"; }

[ -d "$PROFILE_DIR" ] || die "profile 目录不存在：$PROFILE_DIR"
[ -f "$PROFILE_DIR/package.json" ] || die "profile 清单缺失：$PROFILE_DIR/package.json"

case "$ACTION" in
  status)
    python3 - "$PROFILE_DIR" "$PKG" "$ROW_ID" <<'PY'
import json, sys, pathlib
profile_dir, pkg, row_id = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
manifest = json.loads((profile_dir / 'package.json').read_text())
deps = manifest.get('dependencies', {})
bundles = (manifest.get('dsh', {}).get('profile', {}) or {}).get('bundles', [])
patch = profile_dir / 'cordis.patch.yml'
patch_text = patch.read_text() if patch.exists() else ''
print(f"profile       : {profile_dir.name}")
print(f"dependency    : {deps.get(pkg, '(absent)')}")
print(f"in bundles    : {pkg in bundles}")
print(f"row disabled  : {'yes' if row_id in patch_text and 'disabled: true' in patch_text else 'no/unknown'}")
PY
    ;;

  disable)
    python3 - "$PROFILE_DIR" "$ROW_ID" <<'PY'
import pathlib, sys
profile_dir, row_id = pathlib.Path(sys.argv[1]), sys.argv[2]
patch = profile_dir / 'cordis.patch.yml'
text = patch.read_text() if patch.exists() else '[]\n'
block = f"- id: {row_id}\n  disabled: true\n"
if f"id: {row_id}" in text:
    if 'disabled: true' in text:
        print(f"disable: {row_id} 已经是 disabled 状态")
        raise SystemExit(0)
    print(f"disable: {patch} 已包含 {row_id} 行，请手工把该行改成 disabled: true")
    raise SystemExit(1)
if text.strip() in ('', '[]'):
    patch.write_text(block)
else:
    patch.write_text(text.rstrip() + '\n' + block)
print(f"disable: 已在 {patch} 关闭 {row_id} 行（重启 DSH 生效）")
PY
    ;;

  remove)
    if dsh plugin --profile "$PROFILE" remove "$PKG" >/dev/null 2>&1; then
      info "已通过 dsh plugin remove 卸载 $PKG"
    else
      info "dsh 不可用或移除失败，改为直接编辑 profile 清单"
      python3 - "$PROFILE_DIR" "$PKG" <<'PY'
import json, pathlib, sys
profile_dir, pkg = pathlib.Path(sys.argv[1]), sys.argv[2]
manifest_path = profile_dir / 'package.json'
manifest = json.loads(manifest_path.read_text())
manifest.get('dependencies', {}).pop(pkg, None)
profile = manifest.get('dsh', {}).get('profile', {})
bundles = [b for b in profile.get('bundles', []) if b != pkg]
profile['bundles'] = bundles
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
print(f"remove: 已从 {manifest_path} 摘除 {pkg}")
PY
      info "依赖目录可能残留，可执行 purge 或手工删除 $PROFILE_DIR/node_modules"
    fi
    ;;

  purge)
    case "$PROFILE" in
      web|desktop) die "refuse: $PROFILE 是主力 profile，不允许 purge；请改用 disable" ;;
    esac
    python3 - "$PROFILE_DIR" <<'PY'
import pathlib, shutil, sys
target = pathlib.Path(sys.argv[1])
shutil.rmtree(target, ignore_errors=True)
print(f"purge: 已删除 {target}")
PY
    ;;

  *)
    die "未知动作：$ACTION（可用：status | disable | remove | purge）"
    ;;
esac
