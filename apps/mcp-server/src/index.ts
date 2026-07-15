#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PET_SEVERITIES, PET_STATES } from "@codex-3d-pet/protocol";
import { getPetStatus, setPetState, showPetMessage } from "./bridge.js";

const server = new McpServer({ name: "codex-3d-pet", version: "0.1.0" });

server.registerTool(
  "set_pet_state",
  {
    description:
      "更新本地 3D 桌宠的展示状态。接受任务后使用 working；需要用户输入或批准前使用 needs_attention；成功完成后使用 completed；无法继续时使用 error。",
    inputSchema: {
      state: z.enum(PET_STATES).describe("要展示的视觉状态。"),
      message: z.string().max(280).optional().describe("向用户显示的简短气泡消息。"),
      ttl_seconds: z.number().int().min(1).max(3600).optional().describe("可选：回到 idle 状态前的等待时间（秒）。"),
    },
  },
  async (input) => {
    const event = await setPetState(input);
    return {
      content: [{ type: "text", text: `桌宠状态已更新为 ${event.state}。` }],
    };
  },
);

server.registerTool(
  "show_pet_message",
  {
    description: "在本地 3D 桌宠上方显示一条短暂的消息。",
    inputSchema: {
      message: z.string().min(1).max(280).describe("向用户显示的简短消息。"),
      severity: z.enum(PET_SEVERITIES).optional().describe("可选的消息严重程度。"),
    },
  },
  async (input) => {
    await showPetMessage(input);
    return { content: [{ type: "text", text: "桌宠消息已显示。" }] };
  },
);

server.registerTool(
  "get_pet_status",
  {
    description: "检查本地 Codex 3D 桌宠应用是否已连接，以及是否已选择 VRM 角色。",
  },
  async () => {
    const status = await getPetStatus();
    return { content: [{ type: "text", text: JSON.stringify(status) }] };
  },
);

await server.connect(new StdioServerTransport());
