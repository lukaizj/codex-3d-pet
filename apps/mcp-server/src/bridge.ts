import {
  createPetEvent,
  type MessageToolInput,
  type PetStatus,
  type StateToolInput,
} from "@codex-3d-pet/protocol";

export interface BridgeConfig {
  url: string;
  secret: string;
}

function bridgeConfigFromEnv(env = process.env): BridgeConfig {
  const url = env.CODEX_PET_URL ?? "http://127.0.0.1:38241";
  const secret = env.CODEX_PET_SECRET;

  if (!secret) {
    throw new Error("必须设置 CODEX_PET_SECRET。请从 Codex 3D 桌宠的设置面板复制该密钥。");
  }

  return { url: url.replace(/\/$/, ""), secret };
}

async function bridgeFetch(config: BridgeConfig, path: string, init: RequestInit = {}) {
  const response = await fetch(`${config.url}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-codex-pet-secret": config.secret,
      ...init.headers,
    },
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    throw new Error(`Codex 3D 桌宠连接桥返回了 ${response.status}。桌面应用是否正在运行？`);
  }

  return response;
}

export async function setPetState(input: StateToolInput, config = bridgeConfigFromEnv()) {
  const event = createPetEvent(input);
  await bridgeFetch(config, "/event", { method: "POST", body: JSON.stringify(event) });
  return event;
}

export async function showPetMessage(input: MessageToolInput, config = bridgeConfigFromEnv()) {
  await bridgeFetch(config, "/message", { method: "POST", body: JSON.stringify(input) });
}

export async function getPetStatus(config = bridgeConfigFromEnv()): Promise<PetStatus> {
  const response = await bridgeFetch(config, "/status");
  return (await response.json()) as PetStatus;
}

export { bridgeConfigFromEnv };
