# 网络层诊断专家

> 适用范围：连通性、DNS、端口、防火墙、TLS、代理。
> 核心方法：**分层排除**，从下往上，不要跳层。

## 一、分层排除法（顺序不能反）

```
物理/链路 → IP 层 → 端口层 → 应用层 → TLS 层 → DNS
```

| 层 | 测什么 | 命令 | 结论含义 |
|---|---|---|---|
| 链路 | 通不通 | `ping -c4 <host>` | 不通 → 网络/主机问题 |
| IP 路由 | 走哪条路 | `traceroute` / `mtr -rw <host>` | 中途断 → 路由/防火墙 |
| 端口 | 端口开不开 | `nc -zv <host> <port>` | refused=没监听；timed out=被丢包 |
| 应用 | 协议通不通 | `curl -v` / `telnet` | 能连但无响应=服务卡住 |
| TLS | 证书对不对 | `openssl s_client -connect <host>:<port>` | 看 verify return code |
| DNS | 解析对不对 | `dig <name>` / `getent hosts <name>` | NXDOMAIN / 超时 |

**关键判据**：
- `ping 通 + 端口 timed out` = **防火墙 DROP**（不是服务问题）
- `ping 不通 + 端口 refused` = 不可能同时出现，说明测的不是同一台
- `端口 refused` = 主机活着，但没进程监听

## 二、refused 与 timed out 的本质区别

这是最高频的误判点：

| | Connection refused | Connection timed out |
|---|---|---|
| 谁回的 | 目标主机的协议栈 | 没有人回（丢包） |
| 含义 | 主机活着，端口没监听 | 包到不了，或被静默丢弃 |
| 排查方向 | 服务没起 / 端口配错 / 只监听 127.0.0.1 | 防火墙 / 路由 / 主机宕 / 安全组 |
| **不要做** | 不要查防火墙 | 不要重启服务（没用） |

## 三、只监听 127.0.0.1 的坑

`ss -lntp` 输出里 Local Address 是 `127.0.0.1:8080` 表示只接受本机连接。
从外部测必然 refused —— 但服务其实是好的。

修：配置里改 `0.0.0.0` 或具体网卡 IP。**不要**用 `iptables` 转发绕过（会掩盖真正的配置问题）。

## 四、TLS 三层问题

1. **证书过期**：`openssl x509 -noout -dates`
2. **信任链不全**：`unable to get local issuer` → 缺中间证书（服务器要配 fullchain，不是单 cert）
3. **主机名不匹配**：SNI 问题或证书 CN/SAN 不含该域名

## 五、DNS 排查要点

- 内网域名解析失败，先确认 `/etc/resolv.conf` 指对了内网 DNS
- `getent hosts` 比 `nslookup` 更接近应用实际行为（走 nsswitch）
- 检查 `/etc/hosts` 有没有错误覆盖（常见坑：测试遗留条目）
- systemd-resolved 场景：`resolvectl status` 看每个网卡的 DNS

## 六、不要做的事

- ❌ 一上来 `tcpdump` 抓包（先分层排除，抓包是最后手段）
- ❌ 网络问题就重启网络服务（会断掉所有连接，且多半无效）
- ❌ 用 `ping` 通不通判断服务好坏（ICMP 常被单独策略放行/拦截）
