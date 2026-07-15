#!/usr/bin/env node
/** 不依赖 WebGL：检查 GLB/VRM 是否含 embedded 贴图 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const vrmPath = process.argv[2] ?? join(process.cwd(), "test-fixtures/sample.vrm");

function readGlbJson(bytes) {
  const magic = bytes.toString("utf8", 0, 4);
  if (magic !== "glTF") throw new Error("不是 GLB/VRM 文件");
  const jsonLength = bytes.readUInt32LE(12);
  const jsonType = bytes.readUInt32LE(16);
  if (jsonType !== 0x4e4f534a) throw new Error("GLB JSON chunk 无效");
  const jsonStart = 20;
  const jsonText = bytes.toString("utf8", jsonStart, jsonStart + jsonLength);
  return JSON.parse(jsonText);
}

function main() {
  const bytes = readFileSync(vrmPath);
  const gltf = readGlbJson(bytes);
  const images = gltf.images ?? [];
  const materials = gltf.materials ?? [];
  const meshes = gltf.meshes ?? [];
  const embeddedImages = images.filter((img) => img.bufferView != null).length;
  const texturedMaterials = materials.filter((mat) => {
    const pbr = mat.pbrMetallicRoughness ?? {};
    return pbr.baseColorTexture || pbr.metallicRoughnessTexture || mat.normalTexture || mat.emissiveTexture;
  }).length;

  console.log(`文件: ${vrmPath}`);
  console.log(`网格: ${meshes.length}, 材质: ${materials.length}, 图片: ${images.length} (embedded ${embeddedImages})`);
  console.log(`带贴图材质: ${texturedMaterials}`);

  if (meshes.length === 0) throw new Error("无网格");
  if (images.length === 0 && materials.length === 0) throw new Error("无材质/贴图");

  // VRM 常用 MToon，贴图可能在 extensions 里；有 embedded images 即认为文件完整
  if (embeddedImages === 0 && texturedMaterials === 0) {
    console.warn("⚠ 未检测到 embedded 贴图，可能是纯色 VRM");
  } else {
    console.log("✓ 样本 VRM 结构正常");
  }
}

try {
  main();
} catch (error) {
  console.error("✗", error.message ?? error);
  process.exit(1);
}
