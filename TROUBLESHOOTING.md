# 排障手册

本文件记录 `dsh-mobile-tailscale` 在真实环境中出现过的故障、根因和处置方式。每一条都来自实际发生的现场日志，不是推测。

适用对象：DSH Desktop（macOS / Windows）与通过 `dsh plugin` 安装的 web profile。本插件只有一条远程通道 —— `https://<电脑节点>.<tailnet>.ts.net`（Tailscale Serve，Let's Encrypt 证书，访问控制由 tailnet 成员身份承担）；插件不监听局域网端口，没有配对、密钥与自签名证书，因此这里也没有相关条目。

## 快速分诊

| 现象 | 跳到 |
| --- | --- |
| DSH Desktop 启动后所有第三方插件都不见了（进入 Safe Mode） | [1](#1-dsh-desktop-进入-safe-mode) |
| `dsh plugin ... add` 报 `ERR_PNPM_UNEXPECTED_STORE` | [2](#2-err_pnpm_unexpected_store) |
| 插件报 `unsupported DeepSeek Harness version` | [3](#3-unsupported-deepseek-harness-version) |
| 远程面板显示 `ready`，但手机打不开地址 | [4](#4-远程通道显示-ready-但不可达) |
| 手机根本连不上 ts.net 地址 / 提示无法访问 | [7](#7-手机打不开-tsnet-地址) |
| 日志刷 `TimeoutOverflowWarning` / `upstream_unavailable` | [5](#5-timeoutoverflowwarning--upstream_unavailable) |
| 插件安装时报 `resolves outside the installation closure` | [6](#6-resolves-outside-the-installation-closure) |
| 手机端「设置 → 模型」报 `settings are unavailable in this browser`、会话里选不了模型 | [11](#11-手机端设置与模型不可用) |
| 点开菜单（模型列表、会话行的三个点）却自己关掉或跳转走 | [12](#12-点开的菜单被自己关掉) |
| 手机端整体卡 / 打开长会话很慢 | [13](#13-手机端卡顿与长会话载入慢) |
| 每次打开都重新下载几 MB 资源 | [14](#14-远程通道资源被重复下载) |
| 面板上找不到开关 / 想从命令行操作远程通道 | [15](#15-桌面面板与管理接口) |
| 想改手机端外观、加扩展，或 `/mobile` 改坏了页面 | [16](#16-自定义文件与扩展) |
| 某个第三方插件的面板白屏 | [17](#17-第三方插件面板白屏) |
| 想换回 DSH 原生布局 / 专用布局没生效 | [18](#18-手机布局-mobilelayout) |
| 诊断报了不可达 / 想确认 DSH 版本兼容性 | [19](#19-诊断页与-dsh-版本兼容性) |

## 0. 先确定日志与状态位置

```bash
# 1) 先确认实际 DSH_HOME：dsh-mobile CLI 默认取 ~/.dsh
echo "${DSH_HOME:-$HOME/.dsh}"

# 插件装在 profile 的 node_modules 里，用这条确认它到底装到了哪个 profile
ls -d "${DSH_HOME:-$HOME/.dsh}/profiles/"*/node_modules/dsh-mobile-tailscale 2>/dev/null

# 日志（这是最重要的证据来源）
LOG="$HOME/Library/Logs/DSH Desktop/harness.log"

# 插件状态目录
ls -la "${DSH_HOME:-$HOME/.dsh}/mobile-access/"
ls -la "${DSH_HOME:-$HOME/.dsh}/mobile-access/remote/"

# 最近的启动边界，用来把日志按"本次启动"切片
grep -n "^\[desktop\] starting" "$LOG" | tail -5
```

> **DSH_HOME 以实际值为准。** 上面的 `${DSH_HOME:-$HOME/.dsh}` 里 `~/.dsh` 只是默认值（`src/cli.ts:62-63`）；Desktop 进程若设置了 `DSH_HOME`，路径就是它指向的地方。
>
> **历史注记**：早期 Desktop 把 harness 目录放在 `$HOME/Library/Application Support/dsh-desktop/harness`，当前构建不再使用它 —— 照抄旧路径只会看到过期文件，甚至什么也没有。
>
> 本文命令里的 `<profile>` 要换成真实的 profile 名：DSH Desktop 当前默认是 `desktop`；更早的文档写死成 `web`，那只在有 `web` profile 的安装上成立。插件目录始终是 `$DSH_HOME/profiles/<profile>/node_modules/dsh-mobile-tailscale`。

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

**现象**：在终端执行 `dsh plugin --profile <profile> add ...` 失败：

```
ERR_PNPM_UNEXPECTED_STORE  Unexpected store location
```

**根因**：**pnpm 大版本不一致**。profile 的 `node_modules/.modules.yaml` 记录了它被哪个 store 链接：

```bash
grep -E "storeDir" "$DSH_HOME/profiles/<profile>/node_modules/.modules.yaml"
# 例如： "storeDir": "/Users/<you>/Library/pnpm/store/v10"
```

DSH Desktop 内置的 pnpm 与终端 PATH 上的 pnpm 可能是不同大版本（例如 Desktop 用 10.x，Homebrew 装的是 11.x）。pnpm 11 会去 `store/v11`，与 `node_modules` 实际链接的 `v10` 不符，于是直接拒绝操作。

**判定命令**：

```bash
which -a pnpm
pnpm --version    # 终端用的版本

# Desktop 用的版本：当前 Desktop 把自带的 pnpm 放在按 generation 命名的运行时目录里
ls -d "$HOME/Library/Application Support/DSH Desktop/runtime-commands/generations/"*/bin/pnpm
"$(ls -t "$HOME/Library/Application Support/DSH Desktop/runtime-commands/generations/"*/bin/pnpm | head -1)" --version
```

> `$DSH_HOME/.desktop-bin` 是**旧版 Desktop** 的 pnpm shim 目录，在当前安装里**不存在**。当前 Desktop 自带的 pnpm 通常就在上面那条 `runtime-commands/generations/<hash>/bin/` 路径下；`<hash>` 是每代运行时的哈希，目录可能有多个，取最新一个即可。

**处置**：**把 Desktop 自带 pnpm 所在目录放到 PATH 最前面**：

```bash
DESKTOP_PNPM_BIN="$(ls -t "$HOME/Library/Application Support/DSH Desktop/runtime-commands/generations/"*/bin/pnpm | head -1)"
export PATH="$(dirname "$DESKTOP_PNPM_BIN"):$PATH"
pnpm --version    # 确认与 profile 的 store 大版本一致
dsh plugin --profile <profile> add /absolute/path/to/dsh-mobile-tailscale-x.y.z.tgz
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
import json;d=json.load(open('$DSH_HOME/profiles/<profile>/package.json'))
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
const req = createRequire('$DSH_HOME/profiles/<profile>/node_modules/dsh-mobile-tailscale/lib/index.mjs');
try { console.log(req('@deepseek-ai/dsh-host-webserver/package.json').version) } catch { console.log('unknown') }
"

# 装好的插件是否接受它（0.3.3+ 用内部告警路径，assert 仍可用于判定）
node --input-type=module -e "
import { assertSupportedDshVersion } from '$DSH_HOME/profiles/<profile>/node_modules/dsh-mobile-tailscale/lib/index.mjs';
try { assertSupportedDshVersion('<解析到的版本>'); console.log('放行') } catch (e) { console.log('拒绝:', e.message) }
"
```

**处置**：升级插件到已覆盖该版本的新版。若新版本尚未发布，见 [8](#8-从-profile-摘除一个插件) 先摘除以免拖垮宿主。

> **设计约定（勿回退）**：激活期遇到未验证版本只应**告警并继续**（`DSH_MOBILE_UNVERIFIED_DSH_VERSION`），不得抛错。抛错会把宿主的插件树一起弄挂。

## 4. 远程通道显示 `ready` 但不可达

面板显示就绪、地址也拿到了，但手机打不开。

远程地址是**机器级全局**的 `tailscale serve` 配置，不是进程级的。因此有**三个**独立成因，要分别排除。

**成因 A：30 天定时器溢出**（见 [5](#5-timeoutoverflowwarning--upstream_unavailable)）。

**成因 B：443 的注册被覆盖、被清掉，或压根没注册上。** 同一台机器上任何另一套系统的 `tailscale serve` 都会互相覆盖；反过来，本插件对全局配置的改动是**收敛**的：

- **启动**：如果注册 443 时报端口占用，**只有 443 是唯一一条 TCP 条目**才会执行 `tailscale serve reset` 自愈；否则**不碰它**，直接报 `serve_port_conflict`（`src/tailscale-serve.ts:289-309`）。
- **退出**：走 `stopServeIfOwned()`（`src/tailscale-serve.ts:332-341`）—— 先读 `tailscale serve status --json`，**只有当 443 条目仍指向本实例自己的回环代理端口**时才把它 `off` 掉；若已指向别人，就只关自己的监听、**不动 `serve`**。

第二条正是修掉「重启把 ts.net 通道弄没」的改动：无条件 `serve --https=443 off` 会删掉重启时新进程刚注册好的条目，于是 node 上地址被拒、而两个进程都以为自己开着。

**现场报告：面板显示 `ready`，但 `tailscale serve status` 是空的。**
面板状态来自进程内存，不代表 node 上的实际配置。空的 `serve status` 说明注册被清掉或没注册上。端口每次启动都会变，先现查、再注册：

```bash
# 有记录时看 / 的 Proxy；没记录时从监听端口里找插件的回环代理端口
tailscale serve status --json
lsof -nP -iTCP -sTCP:LISTEN | grep DSH
```

```bash
# 用查到的 <远程代理端口> 重新注册（与插件内部同一条命令）
tailscale serve --bg --yes --https=443 http://127.0.0.1:<远程代理端口>
```

也可以回「移动访问」面板点**「重新连接」** —— 它会 stop + start 一次并重新注册。

**成因 C：诊断误报「提供方显示已就绪，但公共地址暂不可达」（0.3.21 前）。** 诊断探针请求 `GET /mobile-access/health`，而**远程代理当时没有这个路由**，请求落到上游被 404，探针据此判为不可达。0.3.21 起远程代理自己应答该路由（`src/remote-proxy.ts:249-260`），这个误报消失。若 0.3.21+ 仍出现同一条提示，说明 ts.net **真的**不可达 —— 先按成因 B 修 `serve`。

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

**处置**：先跑 `tailscale serve status` 确认 443 的归属（空 → 按成因 B 重注册；指向别的服务 → 让开或改端口）；再用上面的 curl 判定。`(tailnet only)` 表示未暴露到公网。

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

> 附带说明：远程通道**现在也直接回答 `GET /mobile-access/health`**（`src/remote-proxy.ts:249-260`，它由代理自己应答、不转发给上游），所以远程诊断探针不再是 404。该镜像提供的资产是 `metadata`、`custom.css`、`custom.js`、`mobile-layout.js`、`mobile-layout-next.js`、`mobile-boot/<key>.js` 与扩展清单（`src/mobile-frontend.ts`、`src/remote-proxy.ts:263-296`）。

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
P="$H/profiles/<profile>/node_modules/dsh-mobile-tailscale"
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

## 7. 手机打不开 ts.net 地址

**现象**：电脑上 `tailscale serve status` 正常、面板也显示就绪，但手机浏览器打开 `https://<machine>.<tailnet>.ts.net` 报无法访问、超时或找不到服务器。

**根因**：这是**手机到 tailnet** 这一段的问题，而不是插件的注册问题。按下面的顺序排除：

1. **手机上 Tailscale 没运行**：打开 Tailscale App，确认已登录且开关是开的。手机不在线时，地址根本无法解析到电脑。
2. **不在同一个 tailnet**：手机登录的是另一个 tailnet（例如工作账号 vs 个人账号）。`tailscale status` 两端都应能看到对方。
3. **Mac 上的 Tailscale 离线**：电脑睡眠、退出登录或 Tailscale 未运行都会让 node 下线。
4. **手机网络拦截 DNS**：个别企业/公共 Wi-Fi 会拦 MagicDNS 名称。切换到蜂窝网络试一次，能通就是 DNS 被拦。
5. **地址抄错**：面板显示的地址以 `https://` 开头、以 `.ts.net` 结尾，且**不要**带端口或路径。手输容易漏字符，优先用面板的复制操作。

**判定命令**（在电脑上跑）：

```bash
tailscale status                       # 两端都应为 online / idle，不能是 offline
tailscale status --json | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['Self']['DNSName'])"
curl -s -o /dev/null -w "%{http_code}\n" https://<machine>.<tailnet>.ts.net/   # 200 = 电脑侧通
```

电脑侧 curl 是 200、手机却打不开，问题就在手机侧（第 1–4 条）。

**处置**：确保手机与 Mac 登录同一 tailnet 且 Tailscale 都在运行；换一个网络验证是否 DNS 被拦；地址一律从面板复制。

## 8. 从 profile 摘除一个插件

当某个插件正在拖垮宿主（[1](#1-dsh-desktop-进入-safe-mode) / [3](#3-unsupported-deepseek-harness-version)）而你想先保其他插件时。

**用官方命令**，它会同时跑 `pnpm remove` 并让 `dsh.profile.bundles` 与安装状态重新对齐：

```bash
DESKTOP_PNPM_BIN="$(ls -t "$HOME/Library/Application Support/DSH Desktop/runtime-commands/generations/"*/bin/pnpm | head -1)"
export PATH="$(dirname "$DESKTOP_PNPM_BIN"):$PATH"     # 见 [2]，必须
dsh plugin --profile <profile> remove <package-name>
# dsh 不在 PATH 时用 Desktop 内置 CLI：
# node "/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js" \
#      plugin --profile <profile> remove <package-name>
```

**先备份**：

```bash
BK="$DSH_HOME/recovery/plugin-removals/manual-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BK"
for f in package.json pnpm-lock.yaml cordis.patch.yml pnpm-workspace.yaml; do
  cp -p "$DSH_HOME/profiles/<profile>/$f" "$BK/$f"
done
```

**摘除后自查**：

```bash
python3 -c "
import json;d=json.load(open('$DSH_HOME/profiles/<profile>/package.json'))
deps=d['dependencies']; bundles=d['dsh']['profile']['bundles']
print('deps:', list(deps)); print('bundles:', bundles)
print('已摘除:', '<package-name>' not in deps and '<package-name>' not in bundles)
"
grep -c "<package-name>" "$DSH_HOME/profiles/<profile>/pnpm-lock.yaml"   # 应为 0
```

然后重启 DSH Desktop 即可脱离 Safe Mode。

## 9. 健康检查清单

远程通道出问题时，按顺序跑完这几项再下结论：

```bash
# 1) 插件在 profile 里且已加载
grep -n "DSH entry loaded" "$LOG" | tail -1

# 2) 远程 443 归属
tailscale serve status --json

# 3) 远程端到端
curl -s -o /dev/null -w "remote %{http_code}\n" https://<machine>.<tailnet>.ts.net/

# 4) 本次启动无定时器溢出
python3 -c "
import re;s=open('$LOG',encoding='utf8',errors='replace').read()
t=s[s.rfind('[desktop] starting'):];print('TimeoutOverflowWarning:', len(re.findall('TimeoutOverflowWarning', t)))
"
```

期望：`DSH entry loaded` / `TCP.443.HTTPS = true` / `remote 200` / `TimeoutOverflowWarning: 0`。

## 10. 卸载与数据清理

```bash
dsh plugin --profile <profile> exec dsh-mobile purge --yes
dsh plugin --profile <profile> remove dsh-mobile-tailscale
```

`purge` 删除整个 `$DSH_HOME/mobile-access/`（远程状态、自定义文件、扩展）。0.4.0 起这里不再有证书或配对设备凭据；局域网时代的 `tls/` 与 `devices.json` 若还留在磁盘上，只可能是从 0.3.x 升级前的遗留文件，`purge` 会一并删除。

> **`dsh-mobile setup` 已不存在。** 它是随局域网通道移除的，运行它只会得到 `unknown command: setup`。

## 11. 手机端设置与模型不可用

**现象**：手机上（经 ts.net 远程通道）「设置 → 模型」报 `settings are unavailable in this browser` / `加载提供方目录失败`，会话里的模型选择器也拿不到模型列表。桌面端一切正常。

**根因**：DSH 在插件激活时**只读一次**宿主信任提示来决定设置后端（`ctx.remote.$host.isLoopback ? "host" : "memory"`）。取值是 `memory` 时就没有宿主支持的设置面，模型目录随之加载失败。

手机页要拿到 `host`，必须满足两件事，缺一不可：

1. 页面带有本插件注入的信任标志（`window.__DSH_MOBILE_TRUSTED_GATEWAY__`），客户端才会把 `connection.isLoopback` 置真。
2. **启动清单里 settings 模块的 `inject` 必须包含本插件**，本插件才会先于 settings 激活。

第 2 条由 `orderAuthenticatedSettings` 写入（`src/mobile-frontend.ts:566-608`）。它比对的模块 id 现在全是常量，别再凭旧文档里的字面量判断：

- 本插件客户端条目 id = **包名** `dsh-mobile-tailscale`（`MOBILE_CLIENT_MODULE = DSH_MOBILE_MODULE_ID`，`src/mobile-frontend.ts:136`、`src/version.ts:21`）。
- 宿主 settings 模块 id = `@deepseek-ai/dsh-client-ui-settings`（`SETTINGS_MODULE`，`src/mobile-frontend.ts:141`）。
- 本插件客户端条目必须在自己的 `inject` 里声明 `@deepseek-ai/dsh-client-connection` 与 `@deepseek-ai/dsh-client-ui-sidebar`，否则改写直接抛 `dsh-mobile client has unsupported dependencies`（`src/mobile-frontend.ts:571-575`）；改写后它的 `inject` 会被重写成 `["@deepseek-ai/dsh-client-connection", <布局槽位模块>]`（`src/mobile-frontend.ts:605`）。

历史漂移（0.3.5 修复，说明为什么这里值得验证）：

- 它曾用写死的模块 id `dsh-mobile` 去找自己，而清单里的条目 id 是包名 —— 找不到就 `return`，排序**静默失效**，客户端与宿主都不报错。测试夹具当时用了同一个过时 id，所以测试全绿而线上失效。
- 同一处要求 settings 的 `inject` 含 `@deepseek-ai/dsh-client-connection`，而 DSH 0.1.2 的 settings 只声明 `@deepseek-ai/dsh-api-remotes` —— **只修 id 会让它抛错并把移动端首页整体 502**，两处必须一起改。当前实现改为：settings 的 `inject` 里**没有** connection 时，判定设置面走 remote，改把本插件挂到 `@deepseek-ai/dsh-api-gateway` 条目的 `inject` 上，并把本插件追加进 settings 的 `inject`（`src/mobile-frontend.ts:596-606`）。

**判定命令**：直接对运行时首页跑一遍改写，解析改写后的启动清单，看 settings 的 `inject` 有没有被追加、本插件条目的 `inject` 是什么：

```bash
node --input-type=module -e "
import { rewriteMobileIndex } from '$DSH_HOME/profiles/<profile>/node_modules/dsh-mobile-tailscale/lib/index.mjs'
import { readFileSync } from 'node:fs'
const out = rewriteMobileIndex(readFileSync('/tmp/dsh-index.html','utf8'))
const at = out.indexOf('window.__DSH_BOOT__')
const boot = JSON.parse(out.slice(out.indexOf('{', at), out.indexOf('</script>', at)).trim().replace(/;$/u, ''))
const mobile = boot.entries.find(e => e.id === 'dsh-mobile-tailscale')
const settings = boot.entries.find(e => e.id === '@deepseek-ai/dsh-client-ui-settings')
console.log('mobile  inject:', JSON.stringify(mobile?.inject))
console.log('settings inject:', JSON.stringify(settings?.inject))
console.log(settings?.inject?.includes('dsh-mobile-tailscale') ? '排序已生效' : '排序未生效')
"
```

期望：`mobile inject` 形如 `["@deepseek-ai/dsh-client-connection","<布局槽位模块>"]`，`settings inject` 里含 `"dsh-mobile-tailscale"`。（槽位模块随 layout 代际而变，不要写死它。）

取 `/tmp/dsh-index.html` 的方式：从本机回环口取 DSH WebServer 提供的**原始首页**（改写前的 stock 文档，改写只发生在手机通道）：

```bash
curl -s -H "Host: 127.0.0.1" http://127.0.0.1:<web-port>/ > /tmp/dsh-index.html
```

若回环首页也需要凭据，就用桌面端浏览器打开首页另存为 HTML，效果相同。

**远程通道另有独立成因**：远程由回环直通代理服务，它必须自己对首页做同样的改写（`rewriteRemoteMobileIndex`）。该改写曾以 `Content-Length` 为前置条件，而 DSH 用 `Transfer-Encoding: chunked` 返回首页 → **每次请求都跳过改写**，远程通道上这套修复等于没生效。所以远程排查时，要确认改写真的执行了，而不是只看面板状态。

**处置**：升级到 0.3.5+。若升级后远程仍失败，看启动日志里有没有 `remote proxy served the stock document: ...` —— 那是改写被跳过的证据。

## 12. 点开的菜单被自己关掉

**现象**：两个不同的表现，根因都在本插件的 stock 面适配层（`native-mobile.ts`）：

- 会话里点底部模型控件 → 点「模型」那一行 → **弹窗直接关掉**（而「推理等级」那一行正常）。
- 会话/项目行点「三个点」→ 选项闪一下 → **侧边栏收起 / 看着像跳进了会话**。

**根因一（模型菜单）**：DSH 的模型菜单是两级的，钻入「模型」层时会**自动聚焦搜索框**，而它的失焦处理会关掉整个弹窗：

```js
useEffect(() => { if (open && pane === "model") searchRef.current?.focus() }, [open, pane])
const onBlur = (event) => { if (rootRef.current?.contains(event.relatedTarget)) return; close() }
```

本插件有个守卫，本意是"会话打开时 DSH 会程序化聚焦 composer，手机上会弹 iOS 键盘"，但它当时会 blur **任何**非用户点出的聚焦字段——搜索框也是 `input`，于是被 blur → 焦点离开弹窗 → `onBlur` → 关闭。「推理等级」层没有搜索框，所以不受影响，这正是那个不对称的来源。守卫现已收窄为只管 composer 编辑器本身。

**根因二（行内三个点）**：竖屏"选中会话后自动收起侧边栏"的监听用 `closest('[role="treeitem"]')` 判断，把**行内任何点击**都当成选中该行，于是 240ms 后收起侧边栏，刚打开的 portal 菜单随之消失。现已要求点击落在行体上（行内按钮不算），与专属布局里本来就有的守卫一致。

**判定命令**：这两个都是本插件行为，不需要看宿主日志。若现象是"某个菜单点开即关"，先确认菜单里是否有自动聚焦的输入框——有，就是根因一这一类。

**处置**：升级到 0.3.5+。

> **注意**：修复后钻入模型列表时**键盘会弹出**，因为 DSH 的设计就是自动聚焦那个搜索框（桌面版同样如此）。这是预期行为，不要为消除它再去 blur 该字段——那正是把弹窗关掉的原因。

## 13. 手机端卡顿与长会话载入慢

**现象**：手机页整体卡（滚动掉帧、切会话发涩）；点开一个很长的会话要等很久才出内容。

**根因**：手机通道**故意把会话窗口改小**——这是设计，不是故障。桌面端一次最多渲染 DSH 自己要求的窗口（客户端页大小 50 条，普通窗口要 500 条），手机上不裁会直接卡死。

- **WebSocket 会话流**：手机页注入的 bootstrap 包了一层 `WebSocket.prototype.send`，凡是 `session/follow` 请求，都把 `request.maxMessages` 压到 `MOBILE_SESSION_WINDOW_MESSAGES = 10`，并 `delete request.turnWindow`（`src/mobile-frontend.ts:100`、`:316`）。
- **HTTP 历史页**：远程通道每页 `REMOTE_HISTORY_PAGE_MESSAGES = 50`（`src/remote-proxy.ts:60`、`:304`）。

**判定**：先确认改写确实进了页面。

```bash
# 在手机浏览器「查看网页源代码」里搜 maxMessages，或把页面源码存到本地
grep -c "maxMessages" /tmp/dsh-mobile-index.html    # ≥1 = 改写已注入
```

若 `session/follow` 帧没被改写，手机会一次拉整个窗口。此时先在面板里跑一次「诊断」（版本 / 远程通道 / Tailscale 提供方 / 手机网络），排除链路问题；再确认上面那段 bootstrap 在不在页里。

**处置**：

- 这个限流是**预期行为**，不要为了"多看几条历史"去改它 —— 那正是卡顿的来源。
- 诊断全绿但仍然慢，多半是网络或设备本身：换 5GHz Wi-Fi、停掉占带宽的应用；经 tailnet 中继时延迟较高的节点可以改用直连（DERP 中继 vs 点对点直连），在 `tailscale status` 里能看到当前是 `direct` 还是 `relay`。

## 14. 远程通道资源被重复下载

**现象**（0.3.15 之前）：手机上每次打开或刷新页面都要重新下载几 MB 脚本与样式（mermaid、three、vendor、shell），即使浏览器缓存是热的。

**根因**：`sanitizeResponseHeaders` 会剥掉上游响应里的 `cache-control` / `expires`（`src/mobile-frontend.ts:1211`），于是被代理过的资源既没有缓存新鲜度、也没有校验器，浏览器下一次导航只能全部重下。DSH 0.1.7 上实测**每次页面加载重下 5.66 MB**（其中 mermaid 3.24 MB、three 0.67 MB）（`src/mobile-frontend.ts:1276-1281`）。

**修复**：对自带内容标识的 URL 返回长缓存 —— `/plugins/**?rev=<revision>` 与 `/assets/**-<hash>.<ext>` 一律 `private, max-age=31536000, immutable`（`revisionedStaticCacheControl`，`src/mobile-frontend.ts:1289-1299`）。远程代理转发响应时会**重新补回**这个头（`src/remote-proxy.ts:333-334`），所以在唯一的远程通道上生效。

**判定**：在手机浏览器开发者工具里看这两类请求的响应头 `Cache-Control`，应为 `private, max-age=31536000, immutable`；第二次打开页面时它们应直接来自 disk/memory cache。

**处置**：升级到 0.3.15+。若 `Cache-Control` 仍然缺失，确认请求 URL 上确实带了 `?rev=` 或 `-<hash>.<ext>` —— 没有内容标识的响应**不会**被长缓存（这是有意为之，缓存错内容更糟）。

## 15. 桌面面板与管理接口

**现象**：想启用/关闭远程访问、重连或重置，但在面板上找不到入口，或想从命令行直接操作远程通道。

**面板形状（0.4.0）**：左下角「移动访问」卡片只有一个视图 —— 远程地址（可用 **复制地址** 复制）、启用/关闭开关、一行状态、**重新连接**，以及 **诊断** 区域。没有标签页、没有二维码、没有设备列表；`reset` 接口只留给命令行与工具，面板里没有按钮。

**管理接口仅限电脑本机**：调用必须满足同源与 `sec-fetch-site` 校验（`assertLocalAdminTrust`，`src/http-security.ts`），非本机（包括手机）的调用会被拒绝：

| 接口 | 作用 |
| --- | --- |
| `GET/POST /api/mobile-access/remote/control` | 读 / 写远程开关（body `{"running":true\|false}`） |
| `POST /api/mobile-access/remote/reconnect` | 停止并重新启动远程通道、重新注册 443 |
| `POST /api/mobile-access/remote/reset` | 清除插件自己保存的远程状态 |
| `GET /api/mobile-access/diagnostics` | 跑一次脱敏诊断 |

**判定命令**（必须在电脑本机跑，`<web-port>` 用 DSH WebServer 的端口）：

```bash
curl -s -H "Host: 127.0.0.1" http://127.0.0.1:<web-port>/api/mobile-access/remote/control
# 期望：{"provider":"tailscale","running":true,"state":"ready","origin":"https://...ts.net/"}
```

**处置**：面板上没有的入口用上面的接口。从别的机器调用会被拒——这是设计，不是故障。`dsh-mobile setup` 不再提供任何替代初始化命令。

## 16. 自定义文件与扩展

**现象**：用 `/mobile` 改过手机端后页面异常，或想知道自定义文件放在哪、怎么加扩展、怎么恢复默认。

**文件位置**：所有自定义内容都在 `$DSH_HOME/mobile-access/` 下：

| 路径 | 内容 |
| --- | --- |
| `mobile-access/mobile.css` | 手机端自定义样式。 |
| `mobile-access/mobile.js` | 手机端自定义脚本。 |
| `mobile-access/extensions/` | 电脑端扩展目录，每个扩展含 `extension.json` 与以本机权限运行的 `host.mjs`。 |
| `mobile-access/remote/control.json` | 远程开关状态。 |
| `mobile-access/remote/provider.json` | 远程提供方选择。 |

**创建扩展脚手架**：

```bash
dsh plugin --profile web exec dsh-mobile extension create <id> [--name <name>]
```

或者在 DSH 对话里直接说需求，例如 `/mobile 把手机端改成终端风格`；`/mobile` 会修改 `mobile.css`/`mobile.js`，需要电脑能力时创建 `extensions/` 下的扩展。

**改坏了怎么恢复**：删掉或清空对应文件即可回退 —— 例如把 `mobile.css`、`mobile.js` 清空，或删除出问题的扩展目录；卸载全部自定义内容用 `dsh plugin --profile web exec dsh-mobile purge --yes`（会同时清掉远程状态）。

**判定**：在手机浏览器 Network 里确认 `/mobile-access/custom.css` 与 `/mobile-access/custom.js` 是否 200；若为 404，说明文件不存在，属于正常回退。

**处置**：`host.mjs` 与本机程序拥有相同权限，仅创建和运行你理解并信任的扩展。

## 17. 第三方插件面板白屏

**现象**：手机端某块面板白屏（典型是右侧栏「文件」页只剩一个「重试」按钮，点几次还是白）；桌面端一切正常或同样报错。

**根因**：有两个第三方插件的客户端模块**在当前 DSH 客户端图上根本无法工作**（`src/mobile-frontend.ts:184-207`）：

- `dsh-better-sidebar`：客户端 `require("@deepseek-ai/dsh-client-ui-primitives")`，而当前 DSH 的客户端图里已经没有这个模块（清单 71 个条目里没有它）→ 它渲染的每一页都死于 `Minified React error #130`；它的宿主半边也激活失败（`sctx.settings.register is not a function`）。
- `dsh-rewind-plugin`：读会话快照里已不再下发的 `snapshot.queue` → `collectPendingTargets` 抛 `TypeError: Cannot read properties of undefined (reading 'filter')`，每次渲染都崩掉 `conversation.session.header.actions` 这个槽位。

**修复**：0.3.17 起，本插件把这两个模块从**手机启动图**里剔除（`MOBILE_BROKEN_ON_DSH_017_MODULES` → `MOBILE_BOOT_EXCLUDED_MODULES` → `PRUNED_CLIENT_MODULES`，`src/mobile-frontend.ts:204-207`、`:224-227`、`:739-742`），并在 `/plugins/events` 的 HMR 图上继续挡住它们的单模块请求（`prunedClientModuleRequest`，`src/mobile-frontend.ts:763-772`），否则页面会被 HMR 帧"把模块拉回来"。剔除后手机端回到原生侧边栏与消息操作。

**桌面端仍然坏**：剔除只作用于**手机通道**，桌面端照常加载这两个插件。若桌面也白屏/报错，请升级或卸载它们（卸载见 [8](#8-从-profile-摘除一个插件)）。

**处置**：升级到 0.3.17+。若手机端仍白屏、且错误信息里出现上面两个包名，说明启动图里还有它们。

## 18. 手机布局 `mobileLayout`

`mobileLayout` 控制手机通道要不要用本插件自带的布局替换 DSH 的布局（`src/config.ts:53`、`:134`、`:313`），默认 `auto`：

| 取值 | 行为 |
| --- | --- |
| `auto`（默认） | 只在 DSH 的布局代际是**本插件已实现**的那一代时才替换（`mobile-layout.js`）；当前代际下保持 DSH 自己的布局（插件仍会做内置的手机面适配）。 |
| `mobile` | 在**当前**布局代际上强制启用专用移动布局（`mobile-layout-next.js`）。 |
| `stock` | 永不替换，永远用 DSH 原生布局。 |

判定逻辑就是 `dedicatedLayoutTarget`（`src/mobile-frontend.ts:697-708`）：布局模块的依赖里带了 `@deepseek-ai/dsh-client-shortcuts` 就说明是新一代（`LAYOUT_GENERATION_MARKER`，`src/mobile-frontend.ts:238`），此时 `auto` **不**替换、`mobile` 才替换。

**配置位置**：profile 的 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里 `mobile-access` 条目的 `config:` 下（结构与仓库根的 `cordis.patch.yml` 相同）：

```yaml
config:
  # …其余键保持不动
  mobileLayout: mobile    # auto（默认）| mobile | stock
```

**判定**：在手机浏览器 Network 里看是否加载了 `/mobile-access/mobile-layout.js`（旧代际）或 `/mobile-access/mobile-layout-next.js`（`mobile` 模式）。这两个请求都不出现，就是走 DSH 原生布局。

## 19. 诊断页与 DSH 版本兼容性

**诊断覆盖范围（0.4.0）**：`GET /api/mobile-access/diagnostics`（面板「诊断」区域调用的就是它）只检查远程通道、Tailscale 提供方与 DSH 版本兼容性，并生成**不含凭据与完整地址**的脱敏报告。它不再检查局域网网卡、防火墙或 `:3443` 监听——那些检查已随局域网通道移除。

**判定命令**（在电脑本机跑）：

```bash
curl -s -H "Host: 127.0.0.1" http://127.0.0.1:<web-port>/api/mobile-access/diagnostics
```

重点看三项：DSH Host 版本是否在插件的已验证集合内、`tailscale` 提供方是否可用、远程地址探测（`GET /mobile-access/health`，期望 `{"ok":true}`）是否通过。

**版本兼容性**：插件启动时把当前 DSH Host 版本与 README 里的已验证集合比对；**未经验证的版本只记录一条 `DSH_MOBILE_UNVERIFIED_DSH_VERSION` 告警并继续启动，绝不中断宿主**（见 [3](#3-unsupported-deepseek-harness-version)）。但较新的 DSH 会在加载前按插件的 `peerDependencies` 校验运行时版本，不覆盖就直接拒绝激活整个插件（日志形如 `Plugin … is incompatible with dsh …`，并提示 `Exact-version exemption`）；这种情况下插件整条不在树里，需要升级插件或在插件管理器里为该精确版本组合授权豁免。

**处置**：诊断报远程不可达时先按 [4](#4-远程通道显示-ready-但不可达) 排查；报版本不兼容时先升级 dsh-mobile-tailscale。
