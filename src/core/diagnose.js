/**
 * 本机故障诊断 —— 规则先算，模型后解释。
 *
 * 设计原则（延续 docs/03 §4.3「判定在前、模型在后」）：
 *   1. **确定性**：同一份日志，任何人跑都得到同一批 findings，不靠模型猜
 *   2. **可追溯**：每条 finding 带日志行号 + 原文摘录，模型只能引用不能编
 *   3. **带措施**：每条规则自带 remedy（处置步骤），这是"给解决措施"的来源
 *   4. **可扩展**：加一条故障类型 = 加一个 RULES 条目，不用改逻辑
 *
 * 关键取舍：规则命中给的是**候选诊断**，不是最终结论。
 *   模型可以结合联网查到的资料补充/推翻，但必须引用 finding 的 id。
 *
 * 零副作用：纯函数。
 */

'use strict';

/**
 * 故障规则库。
 *
 * 字段：
 *   key       —— 稳定标识（模型引用它）
 *   label     —— 中文名
 *   severity  —— critical / high / medium / low
 *   re        —— 命中正则（针对单行）
 *   remedy    —— 处置步骤（数组，按顺序执行）
 *   verify    —— 修完怎么确认好了
 *   category  —— 归类（用于聚合）
 */
const RULES = [
  {
    key: 'disk-full',
    label: '磁盘空间耗尽',
    severity: 'critical',
    category: 'storage',
    re: /no space left on device|disk quota exceeded|write error.*no space|ENOSPC/i,
    remedy: [
      '`df -h` 确认哪个分区满；`df -i` 同时看 inode（inode 满也会报 ENOSPC）',
      '`du -xh --max-depth=1 / | sort -rh | head -20` 逐层定位大目录',
      '优先清理：`/var/log` 轮转日志、`/tmp`、Journal `journalctl --vacuum-size=500M`',
      '检查是否有已删除但仍被进程占用的文件：`lsof +L1`（这类空间要重启进程才释放）',
      '确认不是日志自身暴涨（见 log-flood 规则），否则清完还会满',
    ],
    verify: '`df -h` 目标分区使用率回落到 85% 以下，且业务写入恢复正常',
  },
  {
    key: 'inode-full',
    label: 'inode 耗尽',
    severity: 'critical',
    category: 'storage',
    re: /no space left on device/i,
    remedy: [
      '`df -i` 看 Inodes 使用率；若 100% 则是文件数过多而非容量不足',
      '找小文件密集目录：`find / -xdev -type f | sed "s|/[^/]*$||" | sort | uniq -c | sort -rn | head`',
      '常见元凶：session 文件、缓存碎片、未清理的临时文件',
      '清理后 `df -i` 复查',
    ],
    verify: '`df -i` Inodes 使用率明显下降，新建文件不再报 ENOSPC',
  },
  {
    key: 'oom',
    label: '内存不足 / OOM Killer 杀进程',
    severity: 'critical',
    category: 'memory',
    re: /out of memory|oom-killer|oom_kill|killed process \d+|invoked oom-killer|cannot allocate memory|Cannot allocate memory/i,
    remedy: [
      '`dmesg -T | grep -i -E "oom|killed process"` 确认被杀的进程与触发时刻',
      '`free -h` + `ps aux --sort=-%mem | head` 找内存大户',
      '检查该进程是否有内存泄漏（RSS 随时间单调增长）或并发过高',
      '临时缓解：限制进程内存（systemd `MemoryMax=`）或加 swap',
      '根治：调 JVM/运行时堆上限、修泄漏、或扩容',
    ],
    verify: '关键进程 RSS 稳定、`dmesg` 不再出现新的 oom-kill 记录',
  },
  {
    key: 'service-failed',
    label: '服务启动失败 / 崩溃',
    severity: 'high',
    category: 'service',
    re: /failed to start|failed to (?:re)?start|unit .* entered failed state|Job for .* failed|main process exited|control process exited|status=(?:1|2|3|4|5|6|203|exit-code)/i,
    remedy: [
      '`systemctl status <服务名> -l --no-pager` 看最近退出码与错误',
      '`journalctl -u <服务名> -n 200 --no-pager` 看完整上下文',
      '配置校验：nginx `nginx -t`；apache `apachectl configtest`；sshd `sshd -t`',
      '检查端口是否被占：`ss -lntp | grep <端口>`',
      '检查依赖服务/文件/权限是否就绪',
    ],
    verify: '`systemctl is-active <服务名>` 返回 active，且端口正常监听',
  },
  {
    key: 'port-conflict',
    label: '端口被占用 / 绑定失败',
    severity: 'high',
    category: 'service',
    re: /address already in use|bind\(\) to .* failed|EADDRINUSE|cannot bind/i,
    remedy: [
      '`ss -lntp | grep <端口>` 找出占用进程',
      '确认是否为残留旧进程（`systemctl restart` 未真正杀掉）',
      '若是另一个合法服务占端口 → 改配置端口，不要直接 kill 生产进程',
    ],
    verify: '目标服务成功监听端口，`ss -lntp` 里无冲突',
  },
  {
    key: 'connection-refused',
    label: '连接被拒绝',
    severity: 'high',
    category: 'network',
    re: /connection refused|connect: connection refused|ECONNREFUSED/i,
    remedy: [
      '确认目标端口有进程监听：在目标机 `ss -lntp | grep <端口>`',
      '确认服务本身是否在运行（结合 service-failed）',
      '确认防火墙未拦截：`iptables -L -n` / `firewall-cmd --list-all`',
      '确认不是只监听 127.0.0.1（`ss -lntp` 看 Local Address）',
    ],
    verify: '从客户端 `nc -zv <host> <port>` 或 `curl -v` 能建立连接',
  },
  {
    key: 'timeout',
    label: '连接/请求超时',
    severity: 'high',
    category: 'network',
    re: /connection timed out|timed out|ETIMEDOUT|timeout after|request timeout|upstream timed out/i,
    remedy: [
      '先区分「网络不通」与「服务慢」：`ping` / `traceroute` / `mtr` 看链路',
      '网络层通但端口超时 → 多为防火墙丢包或服务 accept 队列满',
      '服务慢 → 看 CPU/IO 饱和、慢查询、下游依赖超时',
      '检查 `netstat -s | grep -i listen` 的 overflow 计数（backlog 溢出）',
    ],
    verify: '同一请求稳定返回且耗时恢复正常区间',
  },
  {
    key: 'auth-failure',
    label: '认证失败 / 疑似暴力破解',
    severity: 'medium',
    category: 'security',
    re: /failed password|authentication failure|invalid user|permission denied \(publickey|too many authentication failures|Failed to authenticate/i,
    remedy: [
      '统计来源：`grep -c "Failed password" /var/log/auth.log`，按 IP 聚合找高频源',
      '确认是否为已知运维操作（变更窗口内的批量登录）',
      '非预期高频 → 封禁源 IP（fail2ban / 防火墙），并检查是否已有成功登录',
      '**重点**：排查同一 IP 是否有 `Accepted` 记录（可能已攻破）',
      '关闭密码登录、改用密钥 + 限制来源网段',
    ],
    verify: '失败次数回落，且确认无异常来源的成功登录',
  },
  {
    key: 'permission-denied',
    label: '权限不足',
    severity: 'medium',
    category: 'config',
    re: /permission denied|access denied|operation not permitted|EACCES/i,
    remedy: [
      '确认报错进程的运行用户：`ps -o user= -p <pid>`',
      '检查目标文件/目录的属主与权限：`ls -l <路径>`',
      '确认 SELinux/AppArmor 是否拦截：`ausearch -m avc -ts recent`',
      '按最小权限修属主/权限，**不要**直接 `chmod 777`',
    ],
    verify: '同一操作不再报权限错误，且权限变更符合最小权限原则',
  },
  {
    key: 'fd-exhausted',
    label: '文件描述符耗尽',
    severity: 'high',
    category: 'resource',
    re: /too many open files|EMFILE|file descriptor|max file descriptors/i,
    remedy: [
      '`ulimit -n` 看当前进程限制；`cat /proc/<pid>/limits` 看实际生效值',
      '`ls /proc/<pid>/fd | wc -l` 看已用数量',
      '找泄漏：`lsof -p <pid> | awk "{print $5}" | sort | uniq -c | sort -rn`',
      '临时调高 `LimitNOFILE`（systemd）或 `/etc/security/limits.conf`',
      '根治：修连接/socket 未关闭的代码路径',
    ],
    verify: '进程 fd 数量稳定不增长，不再出现 EMFILE',
  },
  {
    key: 'disk-io-error',
    label: '磁盘 IO 错误 / 坏道',
    severity: 'critical',
    category: 'storage',
    re: /I\/O error|blk_update_request|medium error|read error|ata.*failed command|EXT4-fs error|XFS.*corruption/i,
    remedy: [
      '**立即停止对该盘的写操作**，避免扩散',
      '`dmesg -T | grep -i -E "i/o error|medium error|ata"` 确认设备名',
      '`smartctl -a /dev/sdX` 看 SMART 健康与重映射扇区',
      'RAID：`cat /proc/mdstat` 确认是否降级',
      '备份可用数据 → 换盘 → 重建阵列',
    ],
    verify: 'SMART 无新增错误计数，阵列状态 healthy，文件系统检查通过',
  },
  {
    key: 'raid-degraded',
    label: 'RAID 降级',
    severity: 'critical',
    category: 'storage',
    re: /degraded|raid.*fail|md.*faulty|array.*not active/i,
    remedy: [
      '`cat /proc/mdstat` 确认哪块盘掉了',
      '`smartctl -a /dev/sdX` 判断是盘坏还是接触问题',
      '换盘后 `mdadm --add` + 监控 rebuild 进度',
      '**降级期间性能与冗余都受损，尽快处理**',
    ],
    verify: '`/proc/mdstat` 显示 `[UU]` 且无 rebuild 进行中',
  },
  {
    key: 'cert-expired',
    label: '证书过期 / 校验失败',
    severity: 'high',
    category: 'security',
    re: /certificate (?:has )?expired|certificate verify failed|SSL.*expired|CERT_HAS_EXPIRED|unable to get local issuer/i,
    remedy: [
      '`openssl x509 -in <证书> -noout -dates` 确认有效期',
      '确认是服务端证书还是客户端信任链问题',
      '续签/更换证书后 `nginx -s reload`（不要 restart，避免中断）',
      '检查自动续期任务（certbot timer）是否失效',
    ],
    verify: '`openssl s_client -connect <host>:443` 返回 verify return code: 0',
  },
  {
    key: 'dns-failure',
    label: 'DNS 解析失败',
    severity: 'medium',
    category: 'network',
    re: /could not resolve host|name or service not known|temporary failure in name resolution|NXDOMAIN|getaddrinfo.*failed/i,
    remedy: [
      '`cat /etc/resolv.conf` 确认 DNS 服务器可达',
      '`nslookup <域名>` / `dig <域名>` 直接测解析',
      '确认 `/etc/hosts` 是否有错误条目',
      '内网域名 → 确认是否在正确网段、是否需要内网 DNS',
    ],
    verify: '`getent hosts <域名>` 能返回正确 IP',
  },
  {
    key: 'log-flood',
    label: '日志暴涨（可能是抖动或攻击）',
    severity: 'medium',
    category: 'ops',
    // 2026-10-21 修误报：原先匹配任意 ERROR/FATAL 行，导致正常运行中的
    // 每条错误日志都被算成「日志暴涨」（实测误报 297 次）。
    // 单行匹配判断不了"暴涨"——那需要聚合频次。这里只保留真正的洪泛标记，
    // 具体错误本身由上方的 oom / service-failed 等专门规则覆盖。
    re: /log flood|flooding|too many log|rate.?limit(?:ed)? exceeded|throttl(?:ed|ing)|log spam/i,
    remedy: [
      '统计单位时间条数，判断是稳态噪声还是突然暴涨',
      '按消息模板聚类（去掉时间/ID 后聚合），找重复度最高的那条',
      '重复度极高 → 通常是上游重试风暴、健康检查失败循环、或扫描攻击',
      '限流/降噪后再看真实问题，避免日志把磁盘写满（联动 disk-full）',
    ],
    verify: '日志增速回落到基线水平，磁盘增长可预测',
  },
  {
    key: 'segfault',
    label: '进程崩溃（段错误 / core dump）',
    severity: 'high',
    category: 'service',
    re: /segmentation fault|SIGSEGV|core dumped|SIGABRT|general protection fault/i,
    remedy: [
      '`coredumpctl list` / `ls /var/lib/systemd/coredump` 找 core 文件',
      '`gdb <binary> <core>` 取栈，定位崩溃点',
      '确认是否与近期版本/配置变更相关（回滚验证）',
      '确认是否特定输入触发（可用最小复现）',
    ],
    verify: '进程稳定运行，不再产生新 core',
  },
  {
    key: 'clock-drift',
    label: '时间漂移 / NTP 不同步',
    severity: 'medium',
    category: 'ops',
    re: /clock.*(?:skew|drift|unsynchronized)|ntp.*(?:fail|unreachable)|time.*jumped|System clock wrong/i,
    remedy: [
      '`timedatectl status` 看同步状态',
      '`chronyc tracking` / `ntpq -p` 看上游源是否可达',
      '内网需确认 NTP 服务器地址未被防火墙拦',
      '时间漂移会破坏证书校验、日志排序、集群一致性，优先修',
    ],
    verify: '`timedatectl` 显示 `System clock synchronized: yes`',
  },
  {
    key: 'db-connection',
    label: '数据库连接失败 / 连接池耗尽',
    severity: 'high',
    category: 'database',
    re: /too many connections|connection pool (?:exhausted|timeout)|could not connect to (?:server|database)|FATAL:.*connection slots|MySQL server has gone away|lost connection to (?:MySQL|server)/i,
    remedy: [
      '`SHOW PROCESSLIST`（MySQL）/ `SELECT * FROM pg_stat_activity`（PG）看连接来源',
      '确认是连接泄漏（应用未归还）还是并发真的超过上限',
      '临时：调 `max_connections`（需评估内存）或重启连接池',
      '根治：修连接未关闭路径、加连接池上限与超时',
    ],
    verify: '连接数稳定在阈值内，应用无连接异常',
  },
  {
    key: 'slow-query',
    label: '慢查询 / 响应退化',
    severity: 'medium',
    category: 'database',
    re: /slow quer(?:y|ies)|query took \d+|long running quer|lock wait timeout|deadlock found/i,
    remedy: [
      '开慢查询日志，按耗时排序取 TOP N',
      '`EXPLAIN` 分析执行计划，看是否走索引',
      '检查锁等待：`SHOW ENGINE INNODB STATUS` / PG `pg_locks`',
      '死锁 → 统一加锁顺序；缺索引 → 补索引（评估写放大）',
    ],
    verify: '慢查询数量回落到基线，P95 响应时间达标',
  },
  {
    key: 'cpu-load',
    label: 'CPU 高负载 / 进程卡死',
    severity: 'high',
    category: 'resource',
    re: /load average|high cpu|cpu.*\b9\d%|stuck for more than \d+ seconds/i,
    remedy: [
      '`top -b -n1 | head -20` 与 `uptime` 看 load 与 CPU 占用',
      '区分 us（用户态忙）与 sy（内核态忙）与 wa（IO 等待）',
      'wa 高 → 是磁盘问题不是 CPU（查 disk-io-error）',
      '`pidstat -p ALL 1 5` 定位具体进程，`perf top` 看热点函数',
      '确认是否被挖矿/扫描（异常进程名、异常外连）',
    ],
    verify: 'load 回落至 CPU 核数量级以下，业务响应恢复',
  },
  {
    key: 'security-scan',
    label: '疑似端口扫描 / 入侵探测',
    severity: 'high',
    category: 'security',
    re: /probable break-?in attempt|invalid user .* from|refused connection from|disconnect from invalid|Bad protocol version|no matching (?:cipher|host key)/i,
    remedy: [
      '按源 IP 聚合统计频次与目标端口',
      '确认是否为内部漏扫/基线检查（先问安全团队，别急着封）',
      '非预期 → 封 IP + 检查是否已有成功登录',
      '长期：只对必要网段开放端口、关掉密码认证、上 fail2ban',
    ],
    verify: '扫描流量停止，无异常成功登录记录',
  },
];

/**
 * 从日志行里检出故障。
 *
 * @param {string[]} lines 日志行
 * @param {{path?: string, maxFindings?: number}} opts
 * @returns {{findings: object[], scanned: number, hitLines: number}}
 */
function diagnose(lines, opts = {}) {
  const list = Array.isArray(lines) ? lines : [];
  const maxFindings = opts.maxFindings ?? 60;
  const byKey = new Map();
  let hitLines = 0;

  for (let i = 0; i < list.length; i++) {
    const line = list[i];
    if (!line || line.length > 4000) continue; // 超长行跳过（多为二进制垃圾）
    for (const rule of RULES) {
      if (!rule.re.test(line)) continue;
      hitLines++;
      const cur = byKey.get(rule.key);
      if (cur) {
        cur.count++;
        // 保留前 3 条样本做证据
        if (cur.samples.length < 3) {
          cur.samples.push({ line: i + 1, text: line.slice(0, 300) });
        }
      } else {
        byKey.set(rule.key, {
          id: `${opts.path ? 'f' : 'f'}-${rule.key}`,
          key: rule.key,
          label: rule.label,
          severity: rule.severity,
          category: rule.category,
          path: opts.path || '',
          count: 1,
          samples: [{ line: i + 1, text: line.slice(0, 300) }],
          remedy: rule.remedy,
          verify: rule.verify,
        });
      }
      break; // 一行只归一个类，避免重复计数
    }
  }

  const sevRank = { critical: 0, high: 1, medium: 2, low: 3 };
  const findings = [...byKey.values()]
    .sort((a, b) => (sevRank[a.severity] - sevRank[b.severity]) || (b.count - a.count))
    .slice(0, maxFindings);

  return { findings, scanned: list.length, hitLines };
}

/**
 * 一句话总评（确定性生成，不依赖模型）。
 * @param {object[]} findings
 * @returns {string}
 */
function summarizeDiagnosis(findings) {
  const list = Array.isArray(findings) ? findings : [];
  if (!list.length) return '本次扫描的日志里没有命中已知故障模式。';
  const crit = list.filter((f) => f.severity === 'critical');
  const high = list.filter((f) => f.severity === 'high');
  const head = `命中 ${list.length} 类问题`;
  const parts = [];
  if (crit.length) parts.push(`严重 ${crit.length} 类（${crit.map((f) => f.label).join('、')}）`);
  if (high.length) parts.push(`高危 ${high.length} 类`);
  if (!parts.length) parts.push('均为中低风险');
  const top = list[0];
  return `${head}：${parts.join('，')}。最需要先看的是「${top.label}」（${top.count} 次）。`;
}

module.exports = { RULES, diagnose, summarizeDiagnosis };
