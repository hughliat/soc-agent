#!/bin/sh
# soc-agent 证据采集脚本 —— 纯只读，不写任何文件（除标准输出）
#
# 用法：
#   sh collect.sh > evidence.txt      # 然后把这个文件内容贴给智能体
#   sh collect.sh                     # 或直接复制终端输出
#
# 设计原则：
#   1. **纯只读**：只执行查询类命令，不改任何系统状态
#   2. **分段清晰**：每段用 === SECTION: xxx === 分隔，方便智能体解析
#   3. **限行**：每段最多 30 行，防止输出过大冲爆上下文
#   4. **平台自适应**：Linux / macOS 命令差异自动分支
#   5. **缺命令不报错**：命令不存在就标注 skipped，不中断
#
# 需要 root 的段会自动跳过并标注 —— 不要为了跑全而盲目加 sudo。
set -u

# ── 工具函数 ──────────────────────────────────────────────
section() {
  printf '\n=== SECTION: %s ===\n' "$1"
}

# 有命令才跑，否则标注跳过
try() {
  _label="$1"; shift
  if command -v "$1" >/dev/null 2>&1; then
    # 每段限 30 行
    "$@" 2>&1 | head -n 30
  else
    echo "[skipped: $1 不存在]"
  fi
}

# 只跑 shell 片段（用于无对应单一命令的场景）
trysh() {
  _label="$1"; shift
  sh -c "$*" 2>&1 | head -n 30
}

PLATFORM=$(uname -s 2>/dev/null || echo unknown)

printf '# soc-agent 证据包\n'
printf '# 采集时间：%s\n' "$(date 2>/dev/null || echo unknown)"
printf '# 平台：%s\n' "$PLATFORM"
printf '# 读取顺序：从上到下，每段一个主题\n'

# ══════════════════ 1. 主机基本信息 ══════════════════
section "host"
trysh host 'hostname 2>/dev/null; echo "---"; uname -a 2>/dev/null'
trysh os_release 'if [ -f /etc/os-release ]; then grep -E "^(PRETTY_NAME|VERSION)=" /etc/os-release; elif [ "$(uname -s)" = Darwin ]; then sw_vers 2>/dev/null; fi'
trysh boot_time 'uptime 2>/dev/null'

# ══════════════════ 2. CPU / 内存 / 负载 ══════════════════
section "cpu"
trysh cpu_info 'if [ "$(uname -s)" = Darwin ]; then sysctl -n machdep.cpu.brand_string 2>/dev/null; sysctl -n hw.ncpu 2>/dev/null; else nproc 2>/dev/null; grep -m1 "model name" /proc/cpuinfo 2>/dev/null; fi'
trysh load 'uptime 2>/dev/null'

section "memory"
trysh mem 'if [ "$(uname -s)" = Darwin ]; then vm_stat 2>/dev/null | head -n 12; else free -h 2>/dev/null; fi'

# ══════════════════ 3. 磁盘（容量 + inode + 布局）══════════════════
section "disk_usage"
try df_h 'df' -h

section "disk_inode"
# macOS 的 df 默认已带 iused/ifree，不用重复；Linux 才需要单独看 inode
trysh inode 'if [ "$(uname -s)" = Darwin ]; then echo "[skip: macOS 的 df 已含 inode 列，见 disk_usage 段]"; else df -i 2>/dev/null | head -n 20; fi'

section "disk_layout"
trysh layout 'if [ "$(uname -s)" = Darwin ]; then diskutil list 2>/dev/null; else lsblk 2>/dev/null; fi'

# ══════════════════ 4. 资源占用 TOP ══════════════════
section "top_cpu"
trysh top_cpu 'ps aux 2>/dev/null | head -n 1; ps aux 2>/dev/null | sort -k3 -rn | head -n 12'

section "top_mem"
trysh top_mem 'ps aux 2>/dev/null | head -n 1; ps aux 2>/dev/null | sort -k4 -rn | head -n 12'

# ══════════════════ 5. 服务状态 ══════════════════
section "services_failed"
trysh svc_failed 'if command -v systemctl >/dev/null 2>&1; then systemctl --failed --no-pager --no-legend 2>/dev/null; else echo "[skipped: 无 systemctl，macOS 用 launchctl]"; fi'

section "services_running"
trysh svc_running 'if command -v systemctl >/dev/null 2>&1; then systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | head -n 20; else launchctl list 2>/dev/null | head -n 20; fi'

# ══════════════════ 6. 端口与连接 ══════════════════
section "listening_ports"
trysh ports 'if command -v ss >/dev/null 2>&1; then ss -lntp 2>/dev/null; else netstat -lnt 2>/dev/null; fi'

section "connection_states"
trysh conn 'if command -v ss >/dev/null 2>&1; then ss -s 2>/dev/null; else netstat -an 2>/dev/null | awk "{print \$NF}" | sort | uniq -c | sort -rn | head -n 10; fi'

# ══════════════════ 7. 最近变更（排查里命中率最高的一刀）══════════════════
section "recent_etc_changes"
trysh etc_changed 'echo "近 24 小时被改过的 /etc 文件（前 25 个）："; find /etc -type f -mtime -1 2>/dev/null | head -n 25'

section "recent_pkg_changes"
trysh pkg_changed 'if [ -f /var/log/dpkg.log ]; then echo "--- dpkg 最近记录 ---"; tail -n 15 /var/log/dpkg.log; elif [ -f /var/log/yum.log ]; then echo "--- yum 最近记录 ---"; tail -n 15 /var/log/yum.log; elif [ -f /var/log/dnf.log ]; then tail -n 15 /var/log/dnf.log; else echo "[skipped: 未找到包管理日志]"; fi'

# ══════════════════ 8. 关键日志尾部 ══════════════════
section "log_syslog"
trysh syslog 'for f in /var/log/syslog /var/log/messages /var/log/system.log; do if [ -r "$f" ]; then echo "--- $f（最后 15 行）---"; tail -n 15 "$f"; break; fi; done'

section "log_auth"
trysh auth 'for f in /var/log/auth.log /var/log/secure; do if [ -r "$f" ]; then echo "--- $f（最后 15 行）---"; tail -n 15 "$f"; break; fi; done'

section "log_kernel"
trysh kernel 'if [ "$(uname -s)" = Darwin ]; then echo "[skipped: macOS dmesg 需 sudo，跳过]"; else dmesg 2>/dev/null | tail -n 20 || echo "[skipped: dmesg 需 root]"; fi'

# ══════════════════ 9. 安全基线（只读）══════════════════
section "sec_failed_logins"
trysh failed_login 'if [ -r /var/log/auth.log ]; then echo "近 24h 失败密码次数：$(grep -c "Failed password" /var/log/auth.log 2>/dev/null || echo 0)"; echo "来源 TOP5："; grep "Failed password" /var/log/auth.log 2>/dev/null | awk "{print \$(NF-3)}" | sort | uniq -c | sort -rn | head -n 5; elif [ -r /var/log/secure ]; then grep -c "Failed password" /var/log/secure 2>/dev/null; else echo "[skipped: 无 auth 日志]"; fi'

section "sec_listen_all"
trysh listen_all 'echo "监听在 0.0.0.0 / :: 的服务（暴露面）："; if command -v ss >/dev/null 2>&1; then ss -lnt 2>/dev/null | grep -E "0\.0\.0\.0|\[::\]" || echo "(无)"; else netstat -lnt 2>/dev/null | grep -E "0\.0\.0\.0|\*" || echo "(无)"; fi'

section "sec_suid_count"
trysh suid 'if [ "$(uname -s)" = Darwin ]; then echo "[skipped: macOS SUID 检查较慢，跳过]"; else echo "SUID 文件数量（异常增多需警惕）："; find /usr /bin /sbin -perm -4000 -type f 2>/dev/null | wc -l; fi'

section "sec_sudoers"
trysh sudoers 'if [ -r /etc/sudoers ]; then echo "sudo 规则（去注释）："; grep -vE "^#|^$" /etc/sudoers 2>/dev/null | head -n 20; else echo "[skipped: 无读权限]"; fi'

# ══════════════════ 10. 时区与时间（漂移会影响证书/日志排序）══════════════════
section "time"
trysh timeinfo 'date 2>/dev/null; if command -v timedatectl >/dev/null 2>&1; then timedatectl status 2>/dev/null; fi'

printf '\n=== END ===\n'
printf '# 采集完成。请把本文件全文贴给智能体（含 SECTION 分隔行）。\n'
printf '# 注意：若某段显示 [skipped]，说明该信息缺失，诊断时按"未覆盖"处理，不要臆测。\n'
