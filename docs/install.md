# 安装与分发（短期手动方式）

## 自己打包

在项目根目录执行：

```bash
pnpm install
pnpm package
```

### macOS

产物位置（打包完成后会自动复制到 **`dist/installers/`**，方便发送）：

- **DMG（推荐发给别人）**：`dist/installers/Codex 3D 桌宠_0.1.0_aarch64.dmg`
- 原始路径：`apps/desktop/src-tauri/target/release/bundle/dmg/*.dmg`

把 `.dmg` 发给对方即可。对方打开后把应用拖进「应用程序」文件夹。

> 未公证的应用首次打开：右键应用 → **打开** → 再点「打开」。若仍被拦截，在终端执行  
> `xattr -cr "/Applications/Codex 3D 桌宠.app"` 后重试。

如果 `.dmg` 有问题，也可以发同目录下的 **`Codex 3D 桌宠.app.zip`**：解压后把 `.app` 拖进「应用程序」。

### Windows

**Mac 上无法打出 Windows 安装包**（NSIS 安装程序必须在 Windows 上构建）。

任选一种方式：

1. **有 Windows 电脑**：在项目根目录执行 `pnpm package`，产物在 `dist/installers/*-setup.exe`
2. **没有 Windows 电脑**：把代码 push 到 GitHub，等 CI 跑完后，在 Actions 页面下载 `windows-setup-exe` 产物

原始路径：`apps/desktop/src-tauri/target/release/bundle/nsis/*-setup.exe`

## 对方怎么用

1. 安装并打开 **Codex 3D 桌宠**
2. 导入自己的 VRM 文件（需拥有使用权）
3. 右键角色可打开设置（缩放、动画、穿透等）

桌宠本体安装后即可使用。若还要接 **Codex Desktop**，对方仍需按 [`codex-setup.md`](codex-setup.md) 配置 MCP（目前需本机有 Node + 项目源码）。
