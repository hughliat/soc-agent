#!/bin/sh
# 安装定时巡检：高频告警 + 每日日报。
#
# 两个任务做不同的事（别合成一个）：
#   soc-patrol-alert  每 30 分钟  → 只有命中故障才发（不刷屏）
#   soc-patrol-daily  每天 08:00  → 无论有无故障都发日报
#   soc-logmanage     每周日 03:30 → 压缩大日志（只压不删，独立脚本）
#
# 优先用 systemd timer（有日志、有状态、能 systemctl status 查）；
# 没有 systemd 的环境退回 cron。
#
# 用法：
#   ./install-timer.sh            # 安装（幂等）
#   ./install-timer.sh --remove   # 卸载
#   ./install-timer.sh --status   # 看状态
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE=$(command -v node || echo /usr/bin/node)
HOME_DIR="${HOME:-/root}"
SOC_HOME="${SOC_AGENT_HOME:-$HOME_DIR/.dsh/soc-agent}"
LOG_DIR="$SOC_HOME/logs"

ALERT_EVERY="${SOC_ALERT_MINUTES:-30}"
DAILY_AT="${SOC_DAILY_AT:-08:00}"

# 先把配置和模板生成出来，否则第一次跑会因缺配置退出
ensure_config() {
  if [ ! -f "$SOC_HOME/config/patrol.json" ]; then
    echo "首次安装，生成默认配置与模板…"
    SOC_AGENT_HOME="$SOC_HOME" "$NODE" "$HERE/patrol.js" --init
  fi
  mkdir -p "$LOG_DIR"
}

# ────────────────── systemd ──────────────────
install_systemd() {
  unit_dir="$HOME_DIR/.config/systemd/user"
  mkdir -p "$unit_dir"

  cat > "$unit_dir/soc-patrol-alert.service" <<EOF
[Unit]
Description=soc-agent 故障巡检（有故障才发告警）
After=network-online.target

[Service]
Type=oneshot
ExecStart=$NODE $HERE/patrol.js --mode alert
Environment=SOC_AGENT_HOME=$SOC_HOME
# 密钥与 SMTP 配置从用户环境文件读，不写进 unit
EnvironmentFile=-$SOC_HOME/config/env
StandardOutput=append:$LOG_DIR/alert.log
StandardError=append:$LOG_DIR/alert.log
EOF

  cat > "$unit_dir/soc-patrol-alert.timer" <<EOF
[Unit]
Description=soc-agent 故障巡检定时器（每 ${ALERT_EVERY} 分钟）

[Timer]
OnBootSec=5min
OnUnitActiveSec=${ALERT_EVERY}min
AccuracySec=1min
Persistent=true

[Install]
WantedBy=timers.target
EOF

  # 日报时间拆成时/分
  dh=$(echo "$DAILY_AT" | cut -d: -f1)
  dm=$(echo "$DAILY_AT" | cut -d: -f2)

  cat > "$unit_dir/soc-patrol-daily.service" <<EOF
[Unit]
Description=soc-agent 每日巡检日报
After=network-online.target

[Service]
Type=oneshot
ExecStart=$NODE $HERE/patrol.js --mode daily
Environment=SOC_AGENT_HOME=$SOC_HOME
EnvironmentFile=-$SOC_HOME/config/env
StandardOutput=append:$LOG_DIR/daily.log
StandardError=append:$LOG_DIR/daily.log
EOF

  cat > "$unit_dir/soc-patrol-daily.timer" <<EOF
[Unit]
Description=soc-agent 日报定时器（每天 ${DAILY_AT}）

[Timer]
OnCalendar=*-*-* ${dh}:${dm}:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

  # 每周日志压缩（只压不删，独立脚本，不经模型）
  cat > "$unit_dir/soc-logmanage.service" <<EOF
[Unit]
Description=soc-agent 日志压缩（只压不删）

[Service]
Type=oneshot
ExecStart=$NODE $HERE/logmanage.js
Environment=SOC_AGENT_HOME=$SOC_HOME
StandardOutput=append:$LOG_DIR/logmanage.log
StandardError=append:$LOG_DIR/logmanage.log
EOF

  cat > "$unit_dir/soc-logmanage.timer" <<EOF
[Unit]
Description=soc-agent 日志压缩定时器（每周）

[Timer]
OnCalendar=Sun *-*-* 03:30:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now soc-patrol-alert.timer
  systemctl --user enable --now soc-patrol-daily.timer
  systemctl --user enable --now soc-logmanage.timer

  echo "✓ 已用 systemd timer 安装"
  echo "  查看：systemctl --user list-timers | grep soc-patrol"
  echo "  日志：$LOG_DIR/alert.log 与 $LOG_DIR/daily.log"
  echo ""
  echo "  提示：需要用户级 systemd 常驻（未登录也跑）时执行："
  echo "    sudo loginctl enable-linger $USER"
}

# ────────────────── cron ──────────────────
install_cron() {
  # 生成一个独立 crontab 片段，用标记包裹以便幂等替换
  tmp=$(mktemp)
  crontab -l 2>/dev/null | sed '/# >>> soc-agent patrol >>>/,/# <<< soc-agent patrol <<</d' > "$tmp" || true

  dh=$(echo "$DAILY_AT" | cut -d: -f1)
  dm=$(echo "$DAILY_AT" | cut -d: -f2)

  {
    echo '# >>> soc-agent patrol >>>'
    echo "# 故障巡检（每 ${ALERT_EVERY} 分钟，仅故障时发信）"
    echo "*/${ALERT_EVERY} * * * * cd $HERE && SOC_AGENT_HOME=$SOC_HOME $NODE $HERE/patrol.js --mode alert >> $LOG_DIR/alert.log 2>&1"
    echo "# 每日日报（${DAILY_AT}）"
    echo "$dm $dh * * * cd $HERE && SOC_AGENT_HOME=$SOC_HOME $NODE $HERE/patrol.js --mode daily >> $LOG_DIR/daily.log 2>&1"
    echo "# 每周日志压缩（只压不删）"
    echo "30 3 * * 0 cd $HERE && SOC_AGENT_HOME=$SOC_HOME $NODE $HERE/logmanage.js >> $LOG_DIR/logmanage.log 2>&1"
    echo '# <<< soc-agent patrol <<<'
  } >> "$tmp"

  crontab "$tmp"
  rm -f "$tmp"

  echo "✓ 已用 cron 安装"
  echo "  查看：crontab -l | sed -n '/soc-agent patrol/,/soc-agent patrol/p'"
  echo "  日志：$LOG_DIR/alert.log 与 $LOG_DIR/daily.log"
}

remove_all() {
  rm_any=0

  if [ -d "$HOME_DIR/.config/systemd/user" ]; then
    for u in soc-patrol-alert.timer soc-patrol-daily.timer soc-logmanage.timer; do
      if [ -f "$HOME_DIR/.config/systemd/user/$u" ]; then
        systemctl --user disable --now "$u" 2>/dev/null || true
        rm -f "$HOME_DIR/.config/systemd/user/$u"
        rm_any=1
      fi
    done
    for s in soc-patrol-alert.service soc-patrol-daily.service soc-logmanage.service; do
      rm -f "$HOME_DIR/.config/systemd/user/$s"
    done
    systemctl --user daemon-reload 2>/dev/null || true
    [ "$rm_any" = "1" ] && echo "✓ 已移除 systemd timer"
  fi

  if command -v crontab >/dev/null 2>&1; then
    if crontab -l 2>/dev/null | grep -q 'soc-agent patrol'; then
      tmp=$(mktemp)
      crontab -l 2>/dev/null | sed '/# >>> soc-agent patrol >>>/,/# <<< soc-agent patrol <<</d' > "$tmp"
      crontab "$tmp"
      rm -f "$tmp"
      echo "✓ 已移除 cron 条目"
    fi
  fi
}

show_status() {
  echo "配置：$SOC_HOME/config/patrol.json"
  if [ -f "$SOC_HOME/config/patrol.json" ]; then
    node -e "
const c = require('$SOC_HOME/config/patrol.json');
const r = c.recipients || [];
console.log('收件人：' + (r.length ? r.join(', ') : '（未配置 —— 发了也会被拒）'));
console.log('故障阈值：' + (c.severityThreshold || 'high'));
" 2>/dev/null || echo "（配置读取失败）"
  fi
  echo ""
  if command -v systemctl >/dev/null 2>&1 && [ -d "$HOME_DIR/.config/systemd/user" ]; then
    systemctl --user list-timers --no-pager 2>/dev/null | grep -i soc-patrol || echo "systemd：未安装"
  fi
  if command -v crontab >/dev/null 2>&1; then
    if crontab -l 2>/dev/null | grep -q 'soc-agent patrol'; then
      echo "cron：已安装"
    fi
  fi
}

# ── 入口 ──
case "${1:-}" in
  --remove) remove_all; exit 0 ;;
  --status) show_status; exit 0 ;;
  '') ;;
  *) echo "用法：$0 [--remove|--status]" >&2; exit 2 ;;
esac

ensure_config

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  install_systemd
else
  if command -v crontab >/dev/null 2>&1; then
    install_cron
  else
    echo "既没有可用的 systemd（用户级），也没有 crontab。" >&2
    echo "请手动把下面两行加进你的调度系统：" >&2
    echo "  每 ${ALERT_EVERY} 分钟：$NODE $HERE/patrol.js --mode alert" >&2
    echo "  每天 ${DAILY_AT}：$NODE $HERE/patrol.js --mode daily" >&2
    exit 1
  fi
fi

echo ""
echo "下一步："
echo "  1) 填收件人：编辑 $SOC_HOME/config/patrol.json 的 recipients"
echo "  2) 配 SMTP：在 $SOC_HOME/config/env 里写 SOC_SMTP_HOST / SOC_SMTP_FROM 等"
echo "  3) 试跑：$NODE $HERE/patrol.js --dry-run --mode daily"
echo "  4) 立即执行一次：$NODE $HERE/patrol.js --mode daily"
