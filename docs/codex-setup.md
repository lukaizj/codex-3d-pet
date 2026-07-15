# 连接 Codex Desktop

Codex 3D 桌宠使用本地 stdio MCP 服务器。它只会通过经过鉴权的回环连接，向桌宠发送显式的展示状态指令。

## 1. 启动桌面应用

打开 Codex 3D 桌宠，导入 VRM 后进入**设置 → Codex 连接**，复制自动生成的 MCP 配置片段。密钥仅保存在你的本机；请勿提交到代码仓库或分享给他人。

## 2. 将 MCP 服务器添加到 Codex Desktop

请使用 Codex Desktop 的 MCP 配置界面，或其文档所说明的本地配置文件。生成的配置片段形如：

```toml
[mcp_servers.codex_3d_pet]
command = "pnpm"
args = ["--dir", "/absolute/path/to/codex-3d-pet/apps/mcp-server", "start"]
env = { CODEX_PET_SECRET = "<桌面应用显示的密钥>", CODEX_PET_URL = "http://127.0.0.1:38241" }
```

如果工作区位于其他位置，请调整 `args` 中的路径。修改 MCP 配置后，重启或重新加载 Codex Desktop。

## 3. 验证连接

让 Codex 调用 `get_pet_status`。当桌面应用正在运行时，结果应包含 `connected: true`。

## 工具约定

- `set_pet_state` 接受 `idle`、`thinking`、`working`、`needs_attention`、`completed` 或 `error`，并可附带一条简短消息。
- `show_pet_message` 显示一条短暂的气泡消息。
- `get_pet_status` 仅返回连接桥状态和是否已选择角色；它绝不会返回本地路径、提示词数据或凭据。

可让 Codex 按任务流程调用：开始任务时设置 `working`；提问或请求批准前设置 `needs_attention`；成功后设置 `completed`；无法继续时设置 `error`。
