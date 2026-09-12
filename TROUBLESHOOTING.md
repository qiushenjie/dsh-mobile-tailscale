# 排障手册

本文件记录 DSH Mobile 在真实环境中出现过的故障、根因和处置方式。每一条都来自实际发生的现场日志，不是推测。

适用对象：DSH Desktop（macOS / Windows）与通过 `dsh plugin` 安装的 web profile。

## 快速分诊

| 现象 | 跳到 |
| --- | --- |
| DSH Desktop 启动后所有第三方插件都不见了（进入 Safe Mode） | [1](#1-dsh-desktop-进入-safe-mode) |
| `dsh plugin ... add` 报 `ERR_PNPM_UNEXPECTED_STORE` | [2](#2-err_pnpm_unexpected_store) |
| 插件报 `unsupported DeepSeek Harness version` | [3](#3-unsupported-deepseek-harness-version) |
| 远程面板显示 `ready`，但手机打不开地址 | [4](#4-远程通道显示-ready-但不可达) |
| 日志刷 `TimeoutOverflowWarning` / `upstream_unavailable` | [5](#5-timeoutoverflowwarning--upstream_unavailable) |
| 插件安装时报 `resolves outside the installation closure` | [6](#6-resolves-outside-the-installation-closure) |
| 局域网网关起不来 / 3443 未监听 | [7](#7-局域网网关未监听) |

## 0. 先确定日志与状态位置

```bash
# DSH Desktop 的 DSH_HOME（macOS）
export DSH_HOME="$HOME/Library/Application Support/dsh-desktop/harness"

# 日志（这是最重要的证据来源）
LOG="$HOME/Library/Logs/DSH Desktop/harness.log"

# 插件状态目录
ls -la "$DSH_HOME/mobile-access/"

# 最近的启动边界，用来把日志按"本次启动"切片
grep -n "^\[desktop\] starting" "$LOG" | tail -5
```

判断任何问题之前，**先把日志按最后一次 `[desktop] starting` 切开**再 grep，否则会被历史日志误导（本仓库就踩过这个坑：一次早已修复的旧报错被当成当前故障）。

## 1. DSH Desktop 进入 Safe Mode

**现象**：启动后左下角没有「移动访问」等第三方插件，日志出现：

```
[desktop] safe mode: third-party web profile bundles are blocked
```

**根因**：Safe Mode 本身**不是**一个持久化开关，而是"插件树加载失败"之后的兜底启动。只要**任意一个**插件在 `apply()` 阶段抛错，cordis 的加载器就会把整棵插件树判为失败：

```
[harness-node] plugin failures: {"stage":"apply", ..., "message":"<插件抛出的错误>"}
[harness-node] DSH entry failed: dsh: plugin tree failed to load: failed to apply loader entry <entry> (<package>): <错误>
[desktop] Harness entry failed during startup; stopping immediately
[desktop] plugin recovery detection: <package>
[desktop] safe mode: third-party web profile bundles are blocked
```

**所以：一个插件的错误会拖垮宿主，并连带停掉所有其他第三方插件。** 这也是本插件 0.3.3 把版本检查从"抛错"改成"告警"的原因。

**判定命令**：

```bash
# 谁把整棵树弄挂了
grep -n "plugin tree failed to load" "$LOG" | tail -3

# 是否被持久化锁强制进入（而不是插件失败）
grep -c "Profile recovery requires Safe Mode" "$LOG"    # 0 = 不是锁导致的

# 确认是不是我们的插件
grep -n "mobile-access (dsh-mobile-tailscale)" "$LOG" | tail -3
```

**处置**：

1. 从日志里读出抛错的那个插件包名。
2. 按对应章节修（版本类见 [3](#3-unsupported-deepseek-harness-version)）。
3. 想先恢复其他插件：把肇事插件从 profile 摘掉（见 [8](#8-从-profile-摘除一个插件)），然后重启 DSH Desktop。**不需要**手动退出 Safe Mode —— 它只是内存标记，下次启动会正常走 `web` profile。

## 2. `ERR_PNPM_UNEXPECTED_STORE`

**现象**：在终端执行 `dsh plugin --profile web add ...` 失败：

```
ERR_PNPM_UNEXPECTED_STORE  Unexpected store location
```

**根因**：**pnpm 大版本不一致**。profile 的 `node_modules/.modules.yaml` 记录了它被哪个 store 链接：

```bash
grep -E "storeDir" "$DSH_HOME/profiles/web/node_modules/.modules.yaml"
# 例如： "storeDir": "/Users/<you>/Library/pnpm/store/v10"
```

DSH Desktop 内置的 pnpm 与终端 PATH 上的 pnpm 可能是不同大版本（例如 Desktop 用 10.x，Homebrew 装的是 11.x）。pnpm 11 会去 `store/v11`，与 `node_modules` 实际链接的 `v10` 不符，于是直接拒绝操作。

**判定命令**：

```bash
which -a pnpm
pnpm --version    # 终端用的版本
PATH="$DSH_HOME/.desktop-bin:$PATH" pnpm --version   # Desktop 用的版本
```

**处置**：**始终用 DSH Desktop 自带的 pnpm shim**，把它的目录放在 PATH 最前面：

```bash
export PATH="$DSH_HOME/.desktop-bin:$PATH"
pnpm --version    # 确认与 profile 的 store 大版本一致
dsh plugin --profile web add /absolute/path/to/dsh-mobile-tailscale-x.y.z.tgz
```

> ⚠️ **不要忽略伴随的另一条 WARN**：
>
> ```
> [WARN] The "pnpm" field in package.json is no longer read by pnpm.
>        The following keys were ignored: "pnpm.overrides".
> ```
>
> 这是 pnpm 11 才有的警告，说明 **`pnpm.overrides` 被忽略了**。而 DSH Desktop 的 generation 机制正是用它把插件指向本地 generation：
>
> ```json
> "pnpm": { "overrides": { "dsh-cost-meter": "link:../.generations/live/dsh-cost-meter+.../node_modules/dsh-cost-meter" } }
> ```
>
> 一旦 override 被忽略而安装继续跑下去，pnpm 会**改从 npm registry 抓取这些包来替换本地 generation 链接**，破坏 generation 投影体系。<br>
> `ERR_PNPM_UNEXPECTED_STORE` 往往只是碰巧先挡住了这次破坏 —— 它报错反而是好事。

**安装成功的标志**（这两行说明 generation 被正确保护）：

```
dsh-desktop pnpm runner: excluded N generation projection(s) from pnpm
dsh-desktop pnpm runner: restored N generation projection(s) after pnpm
```

**装完自查**：

```bash
python3 -c "
import json;d=json.load(open('$DSH_HOME/profiles/web/package.json'))
print(json.dumps(d.get('pnpm',{}), indent=1))          # 全部应为 link:
print(list(d['dsh']['desktop']['generationProjection']['plugins'].keys()))
"
```

## 3. `unsupported DeepSeek Harness version`

**现象**：升级 DSH Desktop 后插件不再加载，并触发 [1](#1-dsh-desktop-进入-safe-mode)：

```
... message":"unsupported DeepSeek Harness version 0.1.2-rc.1; supported versions: 0.1.0-rc.5, ..."
```

**根因**：插件的版本白名单没跟上新的 Host 版本。`0.3.3` 之前，这个判断在 `apply()` 第一行抛错，因此**直接导致整棵插件树加载失败 → Safe Mode**。

**版本号是怎么读出来的**：插件用 `createRequire` 解析 `@deepseek-ai/dsh-host-webserver/package.json`。而 profile 的闭包目录里是指向 app bundle 的符号链接：

```bash
ls -l "$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-host-webserver"
# -> /Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-host-webserver
```

**符号链接指向 app 内部，所以 DSH Desktop 一升级，解析出的版本就跟着变。** 解析不到时返回 `'unknown'` 并被放行 —— 这就是"以前能用、升级后突然不能用"的原因。

**判定命令**：

```bash
# 当前实际解析到的版本
node --input-type=module -e "
import { createRequire } from 'node:module';
const req = createRequire('$DSH_HOME/profiles/web/node_modules/dsh-mobile-tailscale/lib/index.mjs');
try { console.log(req('@deepseek-ai/dsh-host-webserver/package.json').version) } catch { console.log('unknown') }
"

# 装好的插件是否接受它（0.3.3+ 用内部告警路径，assert 仍可用于判定）
node --input-type=module -e "
import { assertSupportedDshVersion } from '$DSH_HOME/profiles/web/node_modules/dsh-mobile-tailscale/lib/index.mjs';
try { assertSupportedDshVersion('<解析到的版本>'); console.log('放行') } catch (e) { console.log('拒绝:', e.message) }
"
```

**处置**：升级插件到已覆盖该版本的新版。若新版本尚未发布，见 [8](#8-从-profile-摘除一个插件) 先摘除以免拖垮宿主。

> **设计约定（勿回退）**：激活期遇到未验证版本只应**告警并继续**（`DSH_MOBILE_UNVERIFIED_DSH_VERSION`），不得抛错。抛错会把宿主的插件树一起弄挂。

## 4. 远程通道显示 `ready` 但不可达

面板显示就绪、地址也拿到了，但手机打不开。

远程地址是**机器级全局**的 `tailscale serve` 配置，不是进程级的。因此有**两个**独立成因，要分别排除。

**成因 A：30 天定时器溢出**（见 [5](#5-timeoutoverflowwarning--upstream_unavailable)）。

**成因 B：别的程序在抢 443**。同一台机器上任何另一套系统的 `tailscale serve` 都会互相覆盖；本插件在启动时若检测到 443 被占用且 443 是唯一 serve 条目，会执行 `tailscale serve reset` 来自愈 —— 这会连带清掉对方的配置。

**判定命令**：

```bash
tailscale serve status
tailscale serve status --json          # TCP.443.HTTPS 应为 true，且 / 指回插件的回环代理端口
tailscale status --json | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['Self']['DNSName'])"
lsof -nP -iTCP:443 -sTCP:LISTEN
```

健康时的样子（代理端口是插件的 `RemotePassthroughProxy`，随机分配）：

```
https://<machine>.<tailnet>.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:65179
```

**端到端验证**（最可靠，不要在插件面板里下结论）：

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<machine>.<tailnet>.ts.net/
# 200 = 通；000 = 不通
```

**处置**：确认没有第二套系统在管理 443；再用上面的 curl 判定。`(tailnet only)` 表示未暴露到公网。

## 5. `TimeoutOverflowWarning` / `upstream_unavailable`

**现象**：

```
(node:NNNN) TimeoutOverflowWarning: 2592000000 does not fit into a 32-bit signed integer.
Timeout duration was set to 1.
[dsh-mobile-tailscale] remote proxy request failed for GET /mobile-access/extensions/manifest: upstream_unavailable (socket hang up)
[dsh-mobile-tailscale] mobile frontend route failed for GET /mobile-access/health: not_found
```

**根因**：远程免配对 guest 授权使用 **30 天**过期（`2_592_000_000 ms`），而 `setTimeout` 的上限是 **`2^31-1 ms` = 2_147_483_647 ms ≈ 24.85 天**。超出的延迟会被**静默截断成 1 ms**，于是每个远程请求和 WebSocket 都被立刻中止。

0.3.3 起所有由会话过期时间派生的延迟都统一 clamp 到 `MAX_TIMER_DELAY_MS`。

**判定命令**（注意按最后一次启动切片，历史日志会有大量旧记录）：

```bash
python3 - <<'PY'
import re
s = open("/Users/<you>/Library/Logs/DSH Desktop/harness.log", encoding="utf8", errors="replace").read()
tail = s[s.rfind("[desktop] starting"):]
print("本次启动 TimeoutOverflowWarning:", len(re.findall(r"TimeoutOverflowWarning", tail)))
print("本次启动 2592000000:", len(re.findall(r"2592000000", tail)))
PY
```

**处置**：升级到 0.3.3+。修复后本次启动应为 **0 / 0**。

> 附带说明：`/mobile-access/health` 在**远程路径返回 404 是预期的** —— 该端点属于局域网网关；远程免配对镜像只提供 `metadata`、`mobile-layout.js`、`custom.css`、扩展清单。

## 6. `resolves outside the installation closure`

**现象**：DSH Desktop 的 generation 迁移失败：

```
[desktop] migration failed, restoring the pre-upgrade profile: <plugin> failed peer validation:
    @deepseek-ai/cordis resolves outside the installation closure: /Applications/DSH Desktop.app/...
[desktop] profile maintenance frozen: migration deferred (...)
```

**背景**：DSH Desktop 把所有 `@deepseek-ai/*` 与 `react` 视为**宿主单例**，安装 generation 时会**强制从 generation 内删除**它们，再要求它们能从"安装闭包"（`$DSH_HOME/profiles/node_modules`）解析到。

**重要**：这一类报错**很可能来自旧版安装器**。新版安装器的 `fallbackRoot` + `isInsideDirectory` 已能正确接受经由 profile 闭包符号链接解析进 app bundle 的宿主单例。

**判定命令**：直接调用 DSH 自己的校验器，不要凭日志下结论：

```bash
H="$DSH_HOME"; PROBE="$H/profiles/.generations/staging/verify-probe"
P="$H/profiles/web/node_modules/dsh-mobile-tailscale"
rm -rf "$PROBE"; mkdir -p "$PROBE/node_modules"
cp -R "$P" "$PROBE/node_modules/dsh-mobile-tailscale"
node --input-type=module -e "
const { verifyGenerationPeers } = await import('/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/dsh-desktop-market-installer/generations/installer.mjs');
const r = await verifyGenerationPeers('$H', { directory: '$PROBE', pluginName: 'dsh-mobile-tailscale', version: 'x.y.z' });
console.log('ok =', r.ok); console.log(r.problems.join('\n'));
"
rm -rf "$PROBE"
```

**如何解读**：探针目录没有真实 `pnpm install`，所以普通依赖（及其传递依赖）会逐层报 `does not resolve` —— **这是探针产物，不是真实故障**。真正要看的是 `@deepseek-ai/*` 与 `react`：它们出现在 `problems` 里才是真问题。真实的 generation 里 pnpm 会把普通依赖装进 generation，这些报错不会出现。

**处置**：若 `@deepseek-ai/*` / `react` 已不在 `problems` 中，**不要改 `peerDependencies`** —— 在已验证可用的清单上做投机改动只会引入新风险。

## 7. 局域网网关未监听

**判定命令**：

```bash
lsof -nP -iTCP:3443 -sTCP:LISTEN
lsof -nP -iUDP:3443        # 设备发现广播
curl -sk -o /dev/null -w "%{http_code}\n" https://<LAN-IP>:3443/mobile-access/health
# 200 = 健康

# 插件自报状态（<web-port> 用 DSH WebServer 的端口）
curl -s -H "Host: 127.0.0.1" http://127.0.0.1:<web-port>/api/mobile-access/control
curl -s -H "Host: 127.0.0.1" http://127.0.0.1:<web-port>/api/mobile-access/remote/control
# 期望：{"running":true,"origin":"https://<LAN-IP>:3443",...}
#      {"provider":"tailscale","running":true,"state":"ready","origin":"https://...ts.net/"}
```

**常见原因**：

- 插件没装 / 没加载 → 先看 [1](#1-dsh-desktop-进入-safe-mode)、[3](#3-unsupported-deepseek-harness-version)。
- `control.json` 里开关是关的：
  ```bash
  cat "$DSH_HOME/mobile-access/control.json"        # {"version":1,"enabled":true}
  cat "$DSH_HOME/mobile-access/remote/control.json"
  ```
- 局域网地址变了 / 选错网卡：`setup.json` 记录的是网卡名，插件会自动跟随地址变化；必要时用
  `dsh plugin --profile web exec dsh-mobile setup --address 192.168.x.x` 重选。

## 8. 从 profile 摘除一个插件

当某个插件正在拖垮宿主（[1](#1-dsh-desktop-进入-safe-mode) / [3](#3-unsupported-deepseek-harness-version)）而你想先保其他插件时。

**用官方命令**，它会同时跑 `pnpm remove` 并让 `dsh.profile.bundles` 与安装状态重新对齐：

```bash
export PATH="$DSH_HOME/.desktop-bin:$PATH"     # 见 [2]，必须
dsh plugin --profile web remove <package-name>
# dsh 不在 PATH 时用 Desktop 内置 CLI：
# node "/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js" \
#      plugin --profile web remove <package-name>
```

**先备份**：

```bash
BK="$DSH_HOME/recovery/plugin-removals/manual-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BK"
for f in package.json pnpm-lock.yaml cordis.patch.yml pnpm-workspace.yaml; do
  cp -p "$DSH_HOME/profiles/web/$f" "$BK/$f"
done
```

**摘除后自查**：

```bash
python3 -c "
import json;d=json.load(open('$DSH_HOME/profiles/web/package.json'))
deps=d['dependencies']; bundles=d['dsh']['profile']['bundles']
print('deps:', list(deps)); print('bundles:', bundles)
print('已摘除:', '<package-name>' not in deps and '<package-name>' not in bundles)
"
grep -c "<package-name>" "$DSH_HOME/profiles/web/pnpm-lock.yaml"   # 应为 0
```

然后重启 DSH Desktop 即可脱离 Safe Mode。

## 9. 健康检查清单

手机功能出问题时，按顺序跑完这四项再下结论：

```bash
# 1) 插件在 profile 里且已加载
grep -n "DSH entry loaded" "$LOG" | tail -1

# 2) 局域网网关
curl -sk -o /dev/null -w "LAN %{http_code}\n" https://<LAN-IP>:3443/mobile-access/health

# 3) 远程 443 归属
tailscale serve status --json

# 4) 远程端到端
curl -s -o /dev/null -w "remote %{http_code}\n" https://<machine>.<tailnet>.ts.net/

# 5) 本次启动无定时器溢出
python3 -c "
import re;s=open('$LOG',encoding='utf8',errors='replace').read()
t=s[s.rfind('[desktop] starting'):];print('TimeoutOverflowWarning:', len(re.findall('TimeoutOverflowWarning', t)))
"
```

期望：`DSH entry loaded` / `LAN 200` / `TCP.443.HTTPS = true` / `remote 200` / `TimeoutOverflowWarning: 0`。

## 10. 卸载与数据清理

```bash
dsh plugin --profile web exec dsh-mobile purge --yes
dsh plugin --profile web remove dsh-mobile-tailscale
```

`purge` 删除 `$DSH_HOME/mobile-access/`（设置、证书、设备、自定义文件、扩展）。注意其中 `tls/` 与 `devices.json` 含**凭据**，外发或打包前请先清除。
