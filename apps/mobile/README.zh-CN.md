# DeepSeek Harness Android App

[English](README.md) · [返回项目首页](../../README.md)

DeepSeek Harness 是这个轻量、社区维护的 Android WebView 薄壳的显示名称。它不打包另一份 DSH 前端，而是访问插件提供的同一个 HTTPS 地址，因此 App 与手机浏览器会获得相同的 DSH 功能，以及可以实时编辑的 `mobile.css` 外观和 `mobile.js` 功能。

当前只支持 Android。iOS 客户端仍为未发布的本地开发实验，不进入构建、Release 或支持范围。

## 使用

1. 按项目首页的快速开始安装插件并运行 `dsh-mobile setup`。
2. 从 GitHub Release 安装 Android APK。
3. 打开 App 后先选择“局域网访问”或“远程访问”。
4. 局域网连接先在电脑端 **移动访问 → 局域网** 点击「生成配对链接」，再在 App 中打开该链接完成配对；远程连接只支持 Tailscale Serve，不提供配对：手机安装 Tailscale 并加入同一 tailnet 后，直接打开电脑「移动访问 → 远程」显示的 `https://<host>.ts.net` 地址即可。
5. 两种连接分别保存设备凭据。局域网证书固定只保存在 App 内；远程地址由 Tailscale Serve 为 `*.ts.net` 名称签发公开 HTTPS 证书，手机需安装 Tailscale 并加入同一 tailnet 才能访问。

局域网首次配对完成后，App 使用 Android Keystore 加密保存可随时撤销的长期设备 token，日常 Web 会话仍然是短期的。远程通道不保存设备 token：插件在 `*.ts.net` 源上提供免配对的镜像前端，访问控制完全由 tailnet 成员身份承担。电脑的局域网 IP 变化后，App 会扫描默认端口，用稳定的 DSH 安装标识找回同一台电脑，换取新的短期 Web 会话，并自动更新保存的地址。发现过程不会暴露设备 token 或 Session 凭据。

App 会在配对前读取独立的版本元数据，明确区分“App 过旧”“插件过旧”和协议不兼容；旧插件没有该端点时仍按原流程连接。已配对连接会在后台快速恢复，连接选择页可立即操作；自动重试只覆盖短暂断网，以及 Tailscale Serve 启动失败或 443 端口冲突等远程通道错误。

自动发现会同时监听 DNS-SD/mDNS 与周期性 UDP 公告，也保留端口 `3443` 的主动 UDP 查询和私有 Wi-Fi、热点 `/24` 网段探测兜底。结果按稳定安装标识合并并更新地址。首页提供扫码配对、局域网扫描、结果列表，以及手动地址/配对链接输入框（把电脑端「生成配对链接」复制出的链接粘贴进去即可免密钥配对；子网、非默认端口或发现被防火墙拦截时，也可输入 `https://IP:端口` 直接连接）。点击一台 DSH 后才输入它的密钥。手机浏览器首次使用时，可直接打开电脑端「生成配对链接」复制出的链接（配对码自动填入，形如 `https://<lan-ip>:3443/mobile-access/pair#instance=<id>&token=<43 位配对码>`），也可以打开 HTTPS 地址中的 `/mobile-access/pair`，手动输入同一条链接里的 43 位配对码。

## 为什么使用 App

- 没有浏览器地址栏和标签栏，纵向空间更完整。
- 系统返回键先处理同源 WebView 历史。
- 文件选择、同源下载、分享和清除站点数据使用受限的原生实现。
- 与手机浏览器访问同一页面，不形成第二套 UI 或协议。

手机浏览器始终是一等入口；不安装 App 也可以完整完成配对和访问。

## 安全边界

| 控制项 | Android 行为 |
| --- | --- |
| 传输 | 只接受 HTTPS origin，Manifest 禁止明文流量。 |
| TLS | CA 只在 App 内固定；仅接受它为精确主机和有效期签发的服务器证书，其余 `SslError` 全部取消。 |
| Origin | 只保存协议、规范化主机和端口；普通路径、查询和 fragment 不持久化。 |
| 导航 | 同源主页面留在 WebView；用户点击的外部 HTTPS 链接交给系统浏览器。 |
| 权限 | 文件输入使用系统文档选择器；相机仅在主动点击“扫码配对”时申请，用于读取配对二维码。 |
| 下载 | 只允许当前 exact origin 的前台 GET；认证控制路径永不下载。 |
| 数据 | 设备 token 由 Android Keystore 加密；Web 存储位于 App 沙箱；清除站点数据会删除设备凭据、origin、Cookie、缓存和 Web 存储。 |
| 备份 | App 备份关闭，TLS 私钥和签名密钥不得进入仓库。 |

网络安全配置不信任用户安装的 CA。插件会为所选网卡的当前地址签发新的 SAN，App 则在加密设备凭据中保存稳定 CA 固定。

## 移动扩展桥

认证后的页面可以通过 `dshMobile` 扩展调用 Android Bridge。Bridge 只注入到已配对的 HTTPS Origin 和顶层 WebView，不暴露 Cookie、设备令牌、配对密钥、CA 私钥或任意 Android API。

可用能力包括 `files.pick`、`camera.capture`、`share`、`clipboard.read`、`clipboard.write`。文件和拍照结果会转换为页面里的浏览器 `File`。文件选择、拍照等交互同一时间只允许一个；取消、旋转、WebView 销毁或 60 秒超时都会结束对应请求。手机浏览器使用对应 Web API，不支持时返回 `unsupported`。

电脑端扩展是另一层：`host.mjs` 作为 DSH 主机上的可信 Node.js 代码运行，`mobile.js` 通过限定到自身扩展的 Action 和 Route 调用它。App Bridge 不能编辑或上传扩展源文件。

## 构建

需要 Android Studio 或 Android SDK 36 和 JDK 17。仓库已包含 Gradle 8.11.1 Wrapper。

```powershell
Set-Location apps/mobile/android
./gradlew.bat :app:lintDebug :app:testDebugUnitTest :app:assembleDebug -x :app:lintAnalyzeDebugUnitTest -x :app:lintAnalyzeDebugAndroidTest
```

Debug APK 位于 `app/build/outputs/apk/debug/app-debug.apk`。GitHub Release 使用仅保存在仓库 Secrets 中的稳定签名密钥生成已签名 Release APK；签名密钥与密码不会进入源码或构建产物。

## 验收

共享 URL 策略测试覆盖 origin 规范化、配对入口、同源导航和下载路径。真机仍需验证小屏、横屏、刘海与手势区、软键盘、字体缩放、有效与无效 TLS、文件输入、下载、返回、旋转和清除数据后的重新认证。

Apache-2.0 licensed. See [LICENSE](../../LICENSE).
