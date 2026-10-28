# Linux 系统层诊断专家

> 适用范围：进程、内存、CPU、IO、文件系统、内核日志、systemd。
> 不适用：数据库内部（见 database 专家）、网络链路（见 network 专家）。

## 一、先分清「资源饱和」还是「服务异常」

这是最容易走错的一步。顺序错了会绕远路：

| 现象 | 先查 | 不要先查 |
|---|---|---|
| 服务无响应 | 进程是否还活着（`ps`/`systemctl status`） | 不要一上来抓包 |
| 响应慢 | CPU/IO/内存哪个饱和（`top`/`iostat`/`free`） | 不要一上来调参数 |
| 日志报错 | 报错的时间点前后有没有变更 | 不要直接搜报错 |

## 二、资源饱和的三条铁律

1. **load 高 ≠ CPU 忙**。load 统计的是可运行 + 不可中断（D 状态）进程数。IO 卡住也会把 load 顶高。
   - 查：`ps aux | awk '$8 ~ /D/'`（D 状态进程）
   - 查：`top` 里 `wa` 百分比

2. **内存够 ≠ 不会 OOM**。cgroup 限制、overcommit 策略、碎片都可能导致分配失败。
   - 查：`cat /proc/sys/vm/overcommit_memory`
   - 容器：`cat /sys/fs/cgroup/memory.max`

3. **磁盘有空间 ≠ 能写**。inode 耗尽、只读重挂载、配额超限都会失败。
   - 查：`df -i`、`mount | grep " ro,"`、`repquota -a`

## 三、内核日志是最后的真相

应用日志会说谎（重试掩盖、超时归因错），内核日志不会。

```
dmesg -T | grep -i -E "error|fail|oom|segfault|i/o error|call trace"
```

- `call trace` → 内核态问题，看是哪个模块
- `oom-kill` → 内存问题（但要看清杀的是谁、为什么是它）
- `I/O error` / `medium error` → 磁盘硬件，**立即停写**
- `EXT4-fs error` / `XFS corruption` → 文件系统损坏，需 fsck（要在卸载或只读下做）

## 四、systemd 排障套路

```
systemctl status <svc> -l --no-pager    # 退出码 + 最近日志
journalctl -u <svc> -n 200 --no-pager   # 完整上下文
systemctl cat <svc>                     # 实际生效的 unit（含 drop-in）
systemd-analyze verify <unit>           # 静态校验
```

**常见退出码**：
- `203/EXEC` → 可执行文件不存在或无执行权限
- `1/FAILURE` → 程序自己退出，看程序日志
- `exit-code 2` → 多为配置错误
- `timeout` → 启动超时，看是否卡在等依赖

## 五、诊断报告该给什么

1. 症状（客观描述，不加判断）
2. 证据（哪个命令的哪行输出）
3. 根因（能证实的写"确认"，不能的写"推断 + 依据"）
4. 处置（分「立即止血」和「根治」两段）
5. 复发风险（同类问题会不会再来）
