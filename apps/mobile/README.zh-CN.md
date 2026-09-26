# DeepSeek Harness Android App

> **不再维护。** 这个 Android WebView 薄壳已经废弃，**不属于任何受支持的流程**：插件 0.4.0 起唯一的入口是用手机浏览器打开 Tailscale Serve 地址。App 源码仅作为资料保留在仓库里，不再构建、不再发布、也不提供支持。iOS 客户端始终只是未发布的本地实验。
>
> 这个 App 当初是围绕局域网网关、配对链接和 `dsh-mobile setup` 设计的，而这些在 0.4.0 已全部移除。下面的内容不是可用的安装指南，只是记录它曾经是什么。

[English](README.md) · [返回项目首页](../../README.md)

DeepSeek Harness 曾是这个轻量、社区维护的 Android WebView 薄壳的显示名称。它不打包另一份 DSH 前端，而是访问插件提供的同一个 HTTPS 地址，因此 App 与手机浏览器会获得相同的 DSH 功能，以及可以实时编辑的 `mobile.css` 外观和 `mobile.js` 功能。

## 它曾经做什么

- 加载 DSH 的 HTTPS 地址，没有浏览器地址栏和标签栏。
- 系统返回键先处理同源 WebView 历史。
- 文件选择、同源下载、分享和清除站点数据使用受限的原生实现。
- 通过 `dshMobile` 桥提供 `files.pick`、`camera.capture`、`share`、`clipboard.read`、`clipboard.write`。

它的连接流程依赖已移除的局域网通道：`dsh-mobile setup` 初始化、面板生成配对链接或二维码、App 内固定的自签名 CA，以及 `3443` 端口上的 DNS-SD/mDNS 发现。这些现在都不存在了。它也曾认识的远程通道——Tailscale Serve，不需要配对、访问控制由 tailnet 成员身份承担——是插件如今唯一的通道。

手机浏览器始终是一等入口，即使在 App 还在维护时也是可选项。

## 构建

源码仅作历史资料保留。原构建要求为 Android Studio 或 Android SDK 36 和 JDK 17；仓库已包含 Gradle 8.11.1 Wrapper。

```powershell
Set-Location apps/mobile/android
./gradlew.bat :app:lintDebug :app:testDebugUnitTest :app:assembleDebug -x :app:lintAnalyzeDebugUnitTest -x :app:lintAnalyzeDebugAndroidTest
```

Debug APK 曾位于 `app/build/outputs/apk/debug/app-debug.apk`。该源码不再发布任何受支持的版本。

## 验收

共享 URL 策略测试曾覆盖 origin 规范化、配对入口、同源导航和下载路径。真机验收曾覆盖小屏、横屏、刘海与手势区、软键盘、字体缩放、有效与无效 TLS、文件输入、下载、返回、旋转和清除数据后的重新认证。这些都不再是维护承诺。

Apache-2.0 licensed. See [LICENSE](../../LICENSE).
