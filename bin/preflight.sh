#!/bin/sh
# soc-agent 启动自检 —— 任一严重项不通过就拒绝进入 TUI。
#
# 设计原则：
#   1. **失败要能定位**：不只说"检查失败"，要说清哪项、为什么、怎么修
#   2. **分级**：FATAL 阻止启动；WARN 提示但放行
#   3. **只读**：不改任何状态（修复动作打印出来交给人）
#
# 退出码：0 通过 / 1 有 FATAL
set -u

PROFILE="${SOC_PROFILE:-dsh-tui}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROF="$DSH_HOME/profiles/$PROFILE"
PLUGIN="$PROF/node_modules/soc-agent"
TUI="$PROF/node_modules/@deepseek-harness-tui/dsh-tui"
DATA="${SOC_AGENT_HOME:-$DSH_HOME/soc-agent}"

fatal=0
warn=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fatal=$((fatal + 1)); }
note() { printf '  \033[33m!\033[0m %s\n' "$1"; warn=$((warn + 1)); }
fix()  { printf '     修复：%s\n' "$1"; }

printf '\n═══ soc-agent 启动自检 ═══\n\n'

# ── 1. Node 运行时 ──
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "${major:-0}" -ge 18 ]; then
    ok "Node 版本 $(node -v)"
  else
    bad "Node 版本过低：$(node -v)（需要 >= 18）"
    fix "升级 Node 到 18 或 20 LTS"
  fi
else
  bad "找不到 node 命令"
  fix "安装 Node 18+ 并确保在 PATH 中"
fi

# ── 1b. dsh 运行时（本产品是它的插件，不是独立程序）──
if command -v dsh >/dev/null 2>&1; then
  # 不执行 dsh --version：某些版本会进入交互，自检不能被拖住
  ok "dsh 命令可用：$(command -v dsh)"
else
  bad "找不到 dsh 命令 —— 本产品是 dsh 插件，没有它无法运行"
  fix "npm i -g @deepseek-ai/dsh（内网见部署说明「十、离线部署」）"
fi

# ── 2. profile 与插件 ──
if [ -d "$PROF" ]; then
  ok "profile 存在：$PROF"
else
  bad "profile 不存在：$PROF"
  fix "按部署说明创建 profile 或重新运行 install.sh"
fi

if [ -d "$PLUGIN" ]; then
  v=$(node -p "require('$PLUGIN/package.json').version" 2>/dev/null || echo '?')
  ok "soc-agent 已安装（v${v}）"
else
  bad "soc-agent 未安装：$PLUGIN"
  fix "运行 install.sh $PROFILE"
fi

# ── 3. 沙箱锁死是否完好（安全项，必须）──
if [ -f "$PROF/cordis.patch.yml" ]; then
  if grep -q 'soc-readonly' "$PROF/cordis.patch.yml" 2>/dev/null; then
    # 只查**生效配置**，跳过注释（注释里解释历史原因时会提到这两个词，误报过）
    if grep -v '^[[:space:]]*#' "$PROF/cordis.patch.yml" 2>/dev/null | grep -qE 'danger-full-access|workspace-write'; then
      bad "权限表里仍有 danger-full-access / workspace-write"
      fix "删掉这两项，只保留 soc-readonly（重跑 install.sh 可自动修）"
    else
      ok "权限表已锁死（仅 soc-readonly）"
    fi
  else
    bad "权限锁死配置缺失"
    fix "重跑 install.sh ${PROFILE}（会幂等补齐）"
  fi
  grep -q 'mode: read-only' "$PROF/cordis.patch.yml" 2>/dev/null \
    && ok "沙箱模式：read-only" \
    || { bad "沙箱模式不是 read-only"; fix "重跑 install.sh $PROFILE"; }
else
  bad "找不到 cordis.patch.yml"
  fix "重跑 install.sh $PROFILE"
fi

# ── 4. dsh-tui 封禁补丁是否还在（升级会冲掉，必须查）──
if [ -d "$TUI/lib/types" ]; then
  miss=''
  grep -q 'SOC_AGENT_PATCH:launchpad' "$TUI/lib/types/components/launchpadActions.js" 2>/dev/null || miss="$miss 启动页"
  grep -q 'SOC_AGENT_PATCH:commands'  "$TUI/lib/types/commands.js" 2>/dev/null || miss="$miss 命令白名单"
  grep -q 'SOC_AGENT_PATCH:update'    "$TUI/lib/types/update.js" 2>/dev/null || miss="$miss 更新检查"
  grep -q 'SOC_AGENT_PATCH:logo2'     "$TUI/lib/types/screens/Launchpad.js" 2>/dev/null || miss="$miss 启动页标识"

  if [ -z "$miss" ]; then
    ok "dsh-tui 封禁补丁完好"
    # 命令数复核
    n=$(cd "$TUI" && node --input-type=module -e "const m=await import('./lib/types/commands.js');process.stdout.write(String(m.LOCAL_COMMANDS.length));" 2>/dev/null || echo err)
    case "$n" in
      8) ok "可用命令：8 个（白名单）" ;;
      err) note "无法读取命令表（不影响启动）" ;;
      *) bad "命令白名单异常：期望 8 个，实际 $n 个"
         fix "sh $PLUGIN/tools/patch-dsh-tui.sh 重打补丁" ;;
    esac
  else
    bad "dsh-tui 封禁补丁缺失：$miss"
    fix "sh $PLUGIN/tools/patch-dsh-tui.sh（dsh-tui 升级后必须重跑）"
  fi
else
  bad "找不到 dsh-tui：$TUI"
  fix "检查 profile 是否完整安装"
fi

# ── 5. 数据目录可写（审计落盘的地方）──
if mkdir -p "$DATA/audit" "$DATA/events" 2>/dev/null; then
  if [ -w "$DATA/audit" ]; then
    ok "审计目录可写：$DATA/audit"
  else
    bad "审计目录不可写：$DATA/audit"
    fix "chown $(id -un) $DATA/audit"
  fi
else
  bad "无法创建数据目录：$DATA"
  fix "检查 $DSH_HOME 权限"
fi

# ── 6. 模型配置（本地大模型端点）──
model_ok=0
[ -n "${SOC_LLM_API_KEY:-}" ] && model_ok=1
[ -n "${DEEPSEEK_API_KEY:-}" ] && model_ok=1
if [ "$model_ok" = "1" ]; then
  if [ -n "${SOC_LLM_BASE_URL:-}" ]; then
    ok "模型端点已配置：${SOC_LLM_BASE_URL}"
  else
    note "有 API Key 但未设内网端点（会用默认公有云端点）"
    fix "export SOC_LLM_BASE_URL=http://<内网地址>/v1"
  fi
else
  bad "未检测到模型 API Key"
  fix "export SOC_LLM_API_KEY=<key>（或按部署说明配置用户级环境）"
fi

# ── 7. 日志可读性（诊断的前提）──
readable=0
for d in /var/log /Library/Logs; do
  [ -r "$d" ] && readable=1 && break
done
if [ "$readable" = "1" ]; then
  ok "系统日志目录可读"
else
  note "系统日志目录不可读（诊断能力会受限）"
  fix "把运行用户加入 adm/wheel 组，或改用有读权限的账号"
fi

# ── 8. 定时巡检是否真的在跑（最容易「静默停止」的一项）──
# 用户反馈：systemd 用户级 timer 默认登录才跑，人一退出就停，且不报错。
# 这里主动检查，避免"以为在巡检，其实早就停了"。
timer_state="none"
if command -v systemctl >/dev/null 2>&1; then
  if systemctl --user list-timers --no-pager 2>/dev/null | grep -q "soc-patrol"; then
    timer_state="systemd"
  fi
fi
if [ "$timer_state" = "none" ] && command -v crontab >/dev/null 2>&1; then
  if crontab -l 2>/dev/null | grep -q "patrol.js"; then
    timer_state="cron"
  fi
fi

case "$timer_state" in
  systemd)
    # 关键：用户级 timer 需要 linger，否则登录退出就停
    linger=$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo unknown)
    if [ "$linger" = "yes" ]; then
      ok "定时巡检：systemd timer 已启用（linger 已开，退出登录也跑）"
    elif [ "$linger" = "no" ]; then
      note "定时巡检：systemd timer 已装，但未开 linger —— **退出登录后巡检会停**"
      fix "sudo loginctl enable-linger $(id -un)"
    else
      note "定时巡检：systemd timer 已装，但 linger 状态读不到（可能无 loginctl 权限）"
      fix "手工确认：loginctl show-user $(id -un) -p Linger"
    fi
    ;;
  cron)
    ok "定时巡检：cron 已启用"
    ;;
  *)
    note "定时巡检：未安装（告警与日报都不会自动发）"
    fix "sh ${PLUGIN}/bin/install-timer.sh"
    ;;
esac

# ── 结论 ──
printf '\n'
if [ "$fatal" -gt 0 ]; then
  printf '\033[31m✗ 自检未通过：%d 项严重问题，%d 项警告。\033[0m\n' "$fatal" "$warn"
  printf '  按上面的「修复」提示处理后重试。\n\n'
  exit 1
fi
if [ "$warn" -gt 0 ]; then
  printf '\033[33m! 自检通过（%d 项警告），可以启动。\033[0m\n\n' "$warn"
else
  printf '\033[32m✓ 自检全部通过。\033[0m\n\n'
fi
exit 0
