# Codex 3D 桌宠

一款以本地优先为原则、可自定义的 3D VRM 桌宠，面向 Codex Desktop 用户。

## MVP 范围

- 导入你拥有使用权的 VRM 角色。
- 在 Windows 与 Apple Silicon macOS 上运行透明、始终置顶的桌宠。
- 拖动、缩放、显示/隐藏，以及切换鼠标穿透。
- 在 Codex Desktop 中配置本地 MCP 服务器，让 Codex 显式设置桌宠状态。

应用**不会**上传 VRM 文件、Codex 提示词或 Codex 输出，也不会承诺自动识别每一种 Codex Desktop 生命周期事件。

## 工作区

- `apps/desktop`：基于 Tauri 2 + React 的 3D 桌面应用。
- `apps/mcp-server`：本地 stdio MCP 服务器。
- `packages/protocol`：两个应用共用、经过验证的连接桥协议。
- `docs`：Codex 配置与隐私说明。

## 开发

```bash
pnpm install
pnpm --filter @codex-3d-pet/desktop tauri dev
```

在桌面应用打开后，于另一个终端运行 MCP 服务器：

```bash
CODEX_PET_SECRET="<设置面板中显示的密钥>" pnpm --filter @codex-3d-pet/mcp-server start
```

MCP 配置说明请参阅 [`docs/codex-setup.md`](docs/codex-setup.md)。
