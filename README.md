<p align="center">
  <img src="assets/brand/repository-hero.png" alt="用手机使用电脑中的 DeepSeek Harness" width="100%">
</p>

<h1 align="center">dsh-mobile-tailscale</h1>

<p align="center">用手机浏览器，安全地使用电脑里的 DeepSeek Harness。</p>

<p align="center">
  <a href="https://github.com/qiushenjie/dsh-mobile-tailscale"><img src="https://img.shields.io/badge/github-qiushenjie%2Fdsh--mobile--tailscale-181717?logo=github" alt="GitHub"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-0F172A" alt="Apache-2.0"></a>
</p>

<p align="center">
  <a href="#安装">安装</a> ·
  <a href="#使用">使用</a> ·
  <a href="#手机端做了什么">手机端做了什么</a> ·
  <a href="#自定义">自定义</a> ·
  <a href="#配置">配置</a> ·
  <a href="#排障">排障</a> ·
  <a href="CHANGELOG.md">更新记录</a> ·
  <a href="README.en.md">English</a>
</p>

## 这是什么

一个 DSH 插件。它把电脑上运行的 DSH Web 端，通过 **Tailscale Serve** 用 HTTPS 交给同一 tailnet 里的手机：

- 手机浏览器打开 `https://<电脑节点>.<tailnet>.ts.net` 即可使用——不用装 App、不用扫码、不用登录页。
- 访问控制就是 tailnet 成员身份，证书由 Let's Encrypt 签发，因此没有证书警告。
- 不修改 DSH 源码：宿主侧只加一条回环直通代理，客户端侧只注入手机端的交互与布局修复。

```mermaid
flowchart LR
  Phone["手机浏览器"] -->|"tailnet HTTPS"| Serve["Tailscale Serve"]
  Serve --> Proxy["回环直通代理"]
  Proxy --> DSH["原生 DSH Web 与 Host（本机回环）"]
  DSH -->|"同一工作区、会话与事件流"| Phone
```

## 安装

需要 Node `^22.19.0 || >=24.0.0`，手机与电脑安装 [Tailscale](https://tailscale.com/download) 并登录同一 tailnet。本包尚未发布到 npm，从源码安装：

```bash
git clone https://github.com/qiushenjie/dsh-mobile-tailscale.git && cd dsh-mobile-tailscale
npm ci && npm run build && npm pack
dsh plugin --profile web add "$PWD/$(ls -1 dsh-mobile-tailscale-*.tgz | sort -V | tail -1)"
dsh --profile web
```

macOS 的 DSH Desktop 不把 `dsh` 加进 PATH，用内置 CLI 代替（路径随 Desktop 升级变化）：

```bash
node "/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js" \
     plugin --profile desktop add "<tgz 的绝对路径>"
```

- **同一版本覆盖安装不会生效**（pnpm 只报 `added 0`）：先 `rm -rf $DSH_HOME/profiles/<profile>/node_modules/dsh-mobile-tailscale` 再 `add`。
- **宿主代码不热替换**：升级插件后要完全退出并重新打开 DSH Desktop；客户端资源刷新手机页面即可。

## 使用

1. 在 DSH 左下角打开 **移动访问** 面板，点 **启用远程访问**。
2. 面板显示 `https://<电脑节点>.<tailnet>.ts.net` 后，用手机浏览器打开它。
3. 不用时点 **关闭远程访问**（手机页面会随即断开）。

面板只有一个视图：远程地址（**复制地址**）、启用/关闭开关、一行状态、**重新连接**，以及 **诊断**（跑一次脱敏自检）。开关、重连、重置只接受电脑本机调用，接口清单见 [排障手册 §15](TROUBLESHOOTING.md#15-桌面面板与管理接口)。

## 手机端做了什么

手机打开的是电脑上同一个会话与事件流，插件只做三件事：

- **按触屏重排**：会话抽屉、工具详情、设置页、提问卡片和输入栏在窄屏下重排；右侧栏在窄屏变成可滑动的抽屉，不再覆盖对话。
- **去掉触屏噪音**：输入框字号 ≥16px（避免 iOS 自动放大）、按压反馈只作用于真正的按钮/链接行、终端的触碰手势改走 `pan-y`。
- **远程通道提速**：版本化资源长期缓存（导航不再重下约 5.66 MB）、会话首屏只载入 10 条消息、剔除手机渲染不了的桌面模块。细节与实测数据见 [排障手册 §13/§14](TROUBLESHOOTING.md#13-手机端卡顿与长会话载入慢)。

## 自定义

在 DSH 对话里用 `/mobile <需求>`，agent 会直接改 `$DSH_HOME/mobile-access/` 下的文件，保存后手机端几秒内生效：界面与交互改 `mobile.css` / `mobile.js`；需要电脑能力时用 `extensions/`，其 `host.mjs` 以你的本机权限运行。

```text
/mobile 把手机端做成老式终端的样子，让消息像终端输出一样逐行滚动
/mobile 为手机端添加赛博朋克风格的监控面板，实时显示 CPU、内存和磁盘占用
```

手工建扩展脚手架：`dsh plugin --profile web exec dsh-mobile extension create <id> [--name <name>]`。

> `host.mjs` 与本机程序同权限：只创建和运行你理解并信任的扩展。

## 配置

键写在 profile 的 `cordis.patch.yml` 的 `mobile-access` 条目里（或插件管理器的配置面板），除 `stateFile` 外都可省略。

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `mobileLayout` | `auto` | 手机布局策略：`auto` 只在本插件支持该布局代次时替换，`mobile` 强制替换，`stock` 从不替换。 |
| `upstreamOrigin` | `http://127.0.0.1:3080` | 回环上游；远程代理优先跟随 `DSH_WEB_URL`，再回退到这里。 |
| `stateFile` | 必填 | 插件状态文件。随包的 `cordis.patch.yml` 已设为 `$DSH_HOME/mobile-access/state.json`，扩展目录由它推导。 |
| `maxWebSockets` / `maxBodyBytes` / `upstreamTimeoutMs` | `64` / `160 MiB` / `30000` | 远程通道的并发 WebSocket 上限、请求体上限、上游超时。 |

`customCssFile`、`customScriptFile`、`mobileLayoutFile`、`mobileLayoutNextFile` 由插件自行维护，通常不用手写。运行时文件都在 `$DSH_HOME/mobile-access/`：`remote/control.json`（远程开关）、`remote/provider.json`（提供方）、`mobile.css` / `mobile.js`（自定义）、`extensions/`（扩展）。

## 排障

先看 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)（含快速分诊）。最常见的三种：

- **面板显示「已就绪」但地址打不开**：确认 `tailscale status` 两侧都在线，点 **重新连接**，或按 [§4](TROUBLESHOOTING.md#4-远程通道显示-ready-但不可达) 重新注册 443。
- **手机打不开地址**：确认手机 Tailscale 正在运行、与电脑在同一 tailnet，且打开的是面板显示的那个地址。
- **健康检查**：`https://<电脑节点>.<tailnet>.ts.net/mobile-access/health` 返回 `{"ok":true}` 说明通道正常。

## 安全

- 访问控制完全由 **tailnet 成员身份**承担，请只把可信设备加入 tailnet。
- 不要开启 Tailscale Funnel，也不要把节点暴露到公网；不用时关闭远程开关。
- 插件不监听局域网端口，不保存配对密钥、设备凭据或自签名 CA；管理接口只接受电脑本机调用。

完整威胁模型见 [SECURITY.md](SECURITY.md)。

## 兼容性

已验证 DSH `0.1.0-rc.5`、`0.1.0-rc.6`、`0.1.0-rc.7`、`0.1.1-rc.2`、`0.1.2-alpha.1`、`0.1.2-rc.1`、`0.1.7-rc.2`。未列入的版本只记录一条告警并继续启动；较新的 DSH 可能按 `peerDependencies` 在加载前拒绝整个插件，这种情况请升级插件，或为该精确版本组合显式授权豁免。历史对照表见 [排障手册 §19](TROUBLESHOOTING.md#19-诊断页与-dsh-版本兼容性)。

## 卸载

```bash
dsh plugin --profile web remove dsh-mobile-tailscale   # 只卸载插件
dsh plugin --profile web exec dsh-mobile purge --yes   # 连同 $DSH_HOME/mobile-access/ 一起清理
```

## 开发

```bash
npm ci && npm run verify   # 版本校验 + 类型检查 + 测试 + 构建 + 打包干跑
```

## 来源与许可

Apache-2.0，详见 [LICENSE](LICENSE)。项目由 [dsh-mobile](https://github.com/saya-ch/dsh-mobile) fork 而来，0.4.0 起只保留 Tailscale Serve 一条通道，宿主与客户端实现已重写。
