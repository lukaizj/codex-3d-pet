import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { convertFileSrc } from "@tauri-apps/api/core";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  AmbientLight,
  Box3,
  Clock,
  Color,
  DirectionalLight,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import type { PetState } from "@codex-3d-pet/protocol";
import { readVrmBytes } from "./tauri";
import type { AnimationMode } from "../types/pet";

const MODE_INTENSITY: Record<AnimationMode, number> = {
  calm: 0.7,
  lively: 1,
  expressive: 1.25,
};

const STATE_COLORS: Record<PetState, string> = {
  idle: "#86efac",
  thinking: "#a5b4fc",
  working: "#67e8f9",
  needs_attention: "#fcd34d",
  completed: "#6ee7b7",
  error: "#fca5a5",
};

export class AvatarController {
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(28, 1, 0.1, 100);
  private readonly renderer: WebGLRenderer;
  private readonly clock = new Clock();
  private readonly lookAt = new Vector3(0, 1.0, 0);
  private readonly shadow: Mesh;
  private currentVrm?: VRM;
  private animationFrame?: number;
  private resizeObserver?: ResizeObserver;
  private state: PetState = "idle";
  private animationMode: AnimationMode = "lively";
  private userScale = 1;
  private stateStartedAt = 0;
  /** 角色场景基准高度；蹦跳只叠在此之上，避免改到 hips 把模型拽出画面 */
  private rootBaseY = 0;
  /** 姿势平滑：每帧朝目标插值，避免状态切换时瞬间抽动 */
  private readonly pose = {
    spineX: 0,
    spineY: 0,
    spineZ: 0,
    chestX: 0,
    headX: 0,
    headY: 0,
    headZ: 0,
    leftArmX: 0.06,
    leftArmY: 0,
    leftArmZ: 1.22,
    rightArmX: 0.06,
    rightArmY: 0,
    rightArmZ: -1.22,
    leftLowerX: -0.12,
    rightLowerX: -0.12,
    bob: 0,
  };

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.camera.position.set(0, 1.15, 2.35);

    const fill = new AmbientLight(0xffffff, 1.35);
    const key = new DirectionalLight(0xffffff, 1.9);
    key.position.set(1.1, 2.8, 2.2);
    this.scene.add(fill, key);

    this.shadow = new Mesh(
      new PlaneGeometry(0.9, 0.45),
      new MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
      }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.01;
    this.shadow.visible = false;
    this.scene.add(this.shadow);

    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    window.addEventListener("resize", this.resize);
    this.renderLoop();
  }

  async load(filePath: string) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    let gltf;
    try {
      gltf = await loadVrmGltf(loader, filePath);
    } catch (reason) {
      const detail = reason instanceof Error ? `：${reason.message}` : "";
      throw new Error(`无法读取 VRM 文件。请重新导入角色文件${detail}`);
    }

    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) {
      throw new Error("所选文件不包含兼容的 VRM 角色。");
    }

    VRMUtils.rotateVRM0(vrm);
    try {
      VRMUtils.removeUnnecessaryVertices(vrm.scene);
    } catch {
      // ignore
    }

    refreshVrmMaterials(vrm);

    this.currentVrm?.scene.removeFromParent();
    this.currentVrm = vrm;
    this.rootBaseY = vrm.scene.position.y;
    this.scene.add(vrm.scene);
    this.applyScale();
    this.frameCharacter();
    this.shadow.visible = true;
    this.stateStartedAt = this.clock.elapsedTime;
    this.setPresentation(this.state);
  }

  /** 自检：统计贴图/材质是否可用 */
  diagnoseMaterials() {
    if (!this.currentVrm) {
      return { ok: false, meshCount: 0, textureMaps: 0, coloredMaterials: 0, note: "no vrm" };
    }

    let meshCount = 0;
    let textureMaps = 0;
    let coloredMaterials = 0;

    this.currentVrm.scene.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      meshCount += 1;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (!material || typeof material !== "object") continue;
        const maps = material as unknown as Record<string, unknown>;
        if (
          maps.map ||
          maps.emissiveMap ||
          maps.normalMap ||
          maps.shadeMultiplyTexture ||
          maps.matcapTexture ||
          maps.rimMultiplyTexture
        ) {
          textureMaps += 1;
        }
        const color = maps.color ?? maps.litFactor ?? maps.shadeColorFactor;
        if (color && typeof color === "object" && "r" in color) {
          const { r, g, b } = color as { r: number; g: number; b: number };
          if (!(r > 0.92 && g > 0.92 && b > 0.92)) coloredMaterials += 1;
        }
      }
    });

    const ok = meshCount > 0 && (textureMaps > 0 || coloredMaterials > 0);
    return { ok, meshCount, textureMaps, coloredMaterials, note: ok ? "ok" : "white-look" };
  }

  setPresentation(state: PetState) {
    if (state !== this.state) {
      this.state = state;
      this.stateStartedAt = this.clock.elapsedTime;
    } else {
      this.state = state;
    }

    this.scene.background = null;
    this.canvas.style.filter = "";

    const expression = this.currentVrm?.expressionManager;
    if (expression) {
      for (const name of ["happy", "angry", "sad", "relaxed", "surprised"] as const) {
        expression.setValue(name, 0);
      }

      if (state === "idle") expression.setValue("relaxed", 0.2);
      if (state === "completed") expression.setValue("happy", 0.85);
      if (state === "error") expression.setValue("sad", 0.75);
      if (state === "needs_attention") expression.setValue("surprised", 0.7);
      if (state === "thinking") expression.setValue("relaxed", 0.4);
      if (state === "working") expression.setValue("happy", 0.35);
      expression.update();
    }

    const tint = new Color(STATE_COLORS[state]);
    (this.shadow.material as MeshBasicMaterial).color.copy(tint).multiplyScalar(0.35);
  }

  setAnimationMode(mode: AnimationMode) {
    this.animationMode = mode;
  }

  /** 在 webview 客户区坐标下采样画布 alpha，用于形状穿透 */
  sampleAlphaAtClient(clientX: number, clientY: number): number {
    const rect = this.canvas.getBoundingClientRect();
    if (
      clientX < rect.left ||
      clientY < rect.top ||
      clientX >= rect.right ||
      clientY >= rect.bottom
    ) {
      return 0;
    }

    const scaleX = this.canvas.width / Math.max(rect.width, 1);
    const scaleY = this.canvas.height / Math.max(rect.height, 1);
    const px = Math.floor((clientX - rect.left) * scaleX);
    const py = Math.floor((rect.bottom - clientY) * scaleY);
    if (px < 0 || py < 0 || px >= this.canvas.width || py >= this.canvas.height) {
      return 0;
    }

    const gl = this.renderer.getContext();
    const pixel = new Uint8Array(4);
    // 读 3x3 邻域，边缘更好点中
    let maxAlpha = 0;
    for (let oy = -1; oy <= 1; oy += 1) {
      for (let ox = -1; ox <= 1; ox += 1) {
        const sx = Math.min(this.canvas.width - 1, Math.max(0, px + ox));
        const sy = Math.min(this.canvas.height - 1, Math.max(0, py + oy));
        gl.readPixels(sx, sy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        if (pixel[3] > maxAlpha) maxAlpha = pixel[3];
      }
    }
    return maxAlpha;
  }

  setScale(scale: number) {
    this.userScale = scale;
    this.applyScale();
    if (this.currentVrm) this.frameCharacter();
  }

  dispose() {
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.resizeObserver?.disconnect();
    window.removeEventListener("resize", this.resize);
    this.renderer.dispose();
  }

  private applyScale() {
    this.currentVrm?.scene.scale.setScalar(this.userScale);
    this.shadow.scale.setScalar(0.85 + this.userScale * 0.35);
  }

  private frameCharacter() {
    if (!this.currentVrm) return;

    const box = new Box3().setFromObject(this.currentVrm.scene);
    if (box.isEmpty()) return;

    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const height = Math.max(size.y, 0.4);
    const lookY = box.min.y + height * 0.58;
    this.lookAt.set(center.x, lookY, center.z);

    const distance = Math.max(height * 2.05, size.x * 2.4, 1.6);
    this.camera.position.set(center.x, lookY + height * 0.04, center.z + distance);
    this.camera.near = 0.05;
    this.camera.far = Math.max(distance * 6, 40);
    this.camera.lookAt(this.lookAt);
    this.camera.updateProjectionMatrix();

    this.shadow.position.set(center.x, box.min.y + 0.01, center.z);
    this.shadow.scale.set(Math.max(size.x * 1.5, 0.55), Math.max(size.z * 1.5, 0.35), 1);
  }

  private resize = () => {
    const { clientWidth, clientHeight } = this.canvas;
    if (!clientWidth || !clientHeight) return;
    this.camera.aspect = clientWidth / clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(clientWidth, clientHeight, false);
  };

  private renderLoop = () => {
    const delta = this.clock.getDelta();
    // 必须先改 normalized 骨骼，再 update，否则姿势不会吃进网格
    this.applyMotion();
    this.currentVrm?.update(delta);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.render(this.scene, this.camera);
    this.animationFrame = requestAnimationFrame(this.renderLoop);
  };

  private applyMotion() {
    if (!this.currentVrm) return;

    const humanoid = this.currentVrm.humanoid;
    if (!humanoid) return;

    const t = this.clock.elapsedTime;
    const intensity = MODE_INTENSITY[this.animationMode];
    // VRM T 姿手臂水平；约 ±1.25 才能自然垂在身侧（不是 0.1）
    const ARM_DOWN = 1.22;
    const breathe = Math.sin((t * Math.PI * 2) / 4.2) * 0.02 * intensity;
    const sway = Math.sin((t * Math.PI * 2) / 6.5) * 0.035 * intensity;
    const since = Math.max(0, t - this.stateStartedAt);

    const target = {
      spineX: 0,
      spineY: 0,
      spineZ: 0,
      chestX: 0,
      headX: 0,
      headY: 0,
      headZ: 0,
      leftArmX: 0,
      leftArmY: 0,
      leftArmZ: ARM_DOWN,
      rightArmX: 0,
      rightArmY: 0,
      rightArmZ: -ARM_DOWN,
      leftLowerX: 0,
      rightLowerX: 0,
      bob: 0,
    };

    switch (this.state) {
      case "idle": {
        // 自然站立：手臂垂下、轻呼吸、偶尔转头
        target.spineZ = sway;
        target.spineX = breathe;
        target.chestX = breathe * 0.7;
        target.headY = Math.sin(t * 0.45) * 0.12 * intensity;
        target.headX = breathe * 0.4 - 0.02;
        target.leftArmZ = ARM_DOWN + Math.sin(t * 0.9) * 0.04 * intensity;
        target.rightArmZ = -ARM_DOWN - Math.sin(t * 0.9 + 0.6) * 0.04 * intensity;
        target.leftArmX = 0.06 * intensity;
        target.rightArmX = 0.06 * intensity;
        target.leftLowerX = -0.12 * intensity;
        target.rightLowerX = -0.12 * intensity;
        target.bob = Math.sin(t * 1.05) * 0.004 * intensity;
        break;
      }
      case "thinking": {
        // 托腮思考：右手抬到下巴，头微倾，左手自然下垂
        target.spineX = breathe + 0.04 * intensity;
        target.spineZ = sway * 0.35;
        target.headX = 0.12 * intensity;
        target.headY = 0.18 * intensity + Math.sin(t * 0.7) * 0.05 * intensity;
        target.headZ = 0.1 * intensity;
        target.rightArmZ = -0.35 * intensity;
        target.rightArmX = -1.05 * intensity + Math.sin(t * 1.4) * 0.04 * intensity;
        target.rightArmY = 0.35 * intensity;
        target.rightLowerX = -1.35 * intensity;
        target.leftArmZ = ARM_DOWN * 0.95;
        target.leftArmX = 0.08 * intensity;
        target.leftLowerX = -0.2 * intensity;
        target.bob = Math.sin(t * 0.8) * 0.003 * intensity;
        break;
      }
      case "working": {
        // 认真干活：微前倾，双手在身前轻敲/比划
        const tap = Math.sin(t * 5.5);
        target.spineX = 0.1 * intensity + breathe;
        target.spineZ = Math.sin(t * 1.8) * 0.03 * intensity;
        target.chestX = 0.06 * intensity;
        target.headX = 0.14 * intensity + Math.sin(t * 2.2) * 0.03 * intensity;
        target.headY = Math.sin(t * 1.2) * 0.05 * intensity;
        target.leftArmZ = 0.55 * intensity;
        target.leftArmX = -0.55 * intensity + tap * 0.08 * intensity;
        target.leftArmY = 0.15 * intensity;
        target.leftLowerX = -1.05 * intensity;
        target.rightArmZ = -0.55 * intensity;
        target.rightArmX = -0.5 * intensity - tap * 0.08 * intensity;
        target.rightArmY = -0.12 * intensity;
        target.rightLowerX = -1.0 * intensity;
        target.bob = Math.abs(Math.sin(t * 2.6)) * 0.008 * intensity;
        break;
      }
      case "needs_attention": {
        // 招手呼叫：右手高举挥动，身体轻晃
        const wave = Math.sin(t * 5.2);
        const bounce = Math.abs(Math.sin(t * 3.4));
        target.spineZ = sway * 1.1;
        target.spineX = -0.04 * intensity;
        target.headY = Math.sin(t * 2.0) * 0.16 * intensity;
        target.headX = -0.08 * intensity;
        target.rightArmZ = 0.15 * intensity;
        target.rightArmX = -1.55 * intensity + wave * 0.35 * intensity;
        target.rightArmY = 0.25 * intensity;
        target.rightLowerX = -0.35 * intensity + wave * 0.2 * intensity;
        target.leftArmZ = ARM_DOWN * 0.9;
        target.leftArmX = 0.1 * intensity;
        target.leftLowerX = -0.15 * intensity;
        target.bob = bounce * 0.018 * intensity;
        break;
      }
      case "completed": {
        // 开心举手：双手上举轻跳庆祝
        const hop = Math.abs(Math.sin(t * Math.PI * 2.4));
        const sparkle = Math.sin(t * 3.2);
        target.spineX = -0.12 * intensity + breathe;
        target.spineZ = sparkle * 0.05 * intensity;
        target.chestX = -0.06 * intensity;
        target.headX = -0.12 * intensity;
        target.headY = sparkle * 0.08 * intensity;
        target.leftArmZ = 0.25 * intensity;
        target.leftArmX = -1.65 * intensity + sparkle * 0.08 * intensity;
        target.leftArmY = 0.2 * intensity;
        target.leftLowerX = -0.25 * intensity;
        target.rightArmZ = -0.25 * intensity;
        target.rightArmX = -1.65 * intensity - sparkle * 0.08 * intensity;
        target.rightArmY = -0.2 * intensity;
        target.rightLowerX = -0.25 * intensity;
        target.bob = hop * 0.04 * intensity;
        break;
      }
      case "error": {
        // 沮丧：耸肩低头，双手抱臂/捂脸
        target.spineX = 0.22 * intensity + breathe * 0.4;
        target.spineZ = sway * 0.25;
        target.chestX = 0.12 * intensity;
        target.headX = 0.32 * intensity;
        target.headY = Math.sin(t * 0.55) * 0.04 * intensity;
        target.headZ = -0.06 * intensity;
        target.leftArmZ = 0.7 * intensity;
        target.leftArmX = -0.95 * intensity;
        target.leftArmY = 0.45 * intensity;
        target.leftLowerX = -1.2 * intensity;
        target.rightArmZ = -0.7 * intensity;
        target.rightArmX = -0.95 * intensity;
        target.rightArmY = -0.45 * intensity;
        target.rightLowerX = -1.2 * intensity;
        target.bob = Math.sin(t * 0.9) * 0.002 * intensity;
        break;
      }
    }

    // 状态刚切换时略加速贴合，日常更柔和
    const blend = since < 0.35 ? 0.22 : 0.12;
    const p = this.pose;
    p.spineX += (target.spineX - p.spineX) * blend;
    p.spineY += (target.spineY - p.spineY) * blend;
    p.spineZ += (target.spineZ - p.spineZ) * blend;
    p.chestX += (target.chestX - p.chestX) * blend;
    p.headX += (target.headX - p.headX) * blend;
    p.headY += (target.headY - p.headY) * blend;
    p.headZ += (target.headZ - p.headZ) * blend;
    p.leftArmX += (target.leftArmX - p.leftArmX) * blend;
    p.leftArmY += (target.leftArmY - p.leftArmY) * blend;
    p.leftArmZ += (target.leftArmZ - p.leftArmZ) * blend;
    p.rightArmX += (target.rightArmX - p.rightArmX) * blend;
    p.rightArmY += (target.rightArmY - p.rightArmY) * blend;
    p.rightArmZ += (target.rightArmZ - p.rightArmZ) * blend;
    p.leftLowerX += (target.leftLowerX - p.leftLowerX) * blend;
    p.rightLowerX += (target.rightLowerX - p.rightLowerX) * blend;
    p.bob += (target.bob - p.bob) * blend;

    const spine = humanoid.getNormalizedBoneNode("spine");
    const chest =
      humanoid.getNormalizedBoneNode("upperChest") ?? humanoid.getNormalizedBoneNode("chest");
    const head = humanoid.getNormalizedBoneNode("head");
    const leftArm = humanoid.getNormalizedBoneNode("leftUpperArm");
    const rightArm = humanoid.getNormalizedBoneNode("rightUpperArm");
    const leftLower = humanoid.getNormalizedBoneNode("leftLowerArm");
    const rightLower = humanoid.getNormalizedBoneNode("rightLowerArm");

    if (spine) {
      spine.rotation.set(p.spineX, p.spineY, p.spineZ);
    }
    if (chest) chest.rotation.x = p.chestX;
    if (head) head.rotation.set(p.headX, p.headY, p.headZ);
    if (leftArm) leftArm.rotation.set(p.leftArmX, p.leftArmY, p.leftArmZ);
    if (rightArm) rightArm.rotation.set(p.rightArmX, p.rightArmY, p.rightArmZ);
    if (leftLower) leftLower.rotation.x = p.leftLowerX;
    if (rightLower) rightLower.rotation.x = p.rightLowerX;

    this.currentVrm.scene.position.y = this.rootBaseY + p.bob;
    this.currentVrm.scene.rotation.y = 0;
    this.currentVrm.scene.rotation.z = 0;
  }
}

async function loadVrmGltf(loader: GLTFLoader, filePath: string) {
  const errors: string[] = [];

  // 应用目录内的文件：asset 协议最稳，贴图 blob 也能正常走 ImageLoader
  try {
    return await loader.loadAsync(convertFileSrc(filePath));
  } catch (reason) {
    errors.push(reason instanceof Error ? reason.message : "asset 加载失败");
  }

  const raw = await readVrmBytes(filePath);
  const bytes =
    raw instanceof ArrayBuffer
      ? new Uint8Array(raw)
      : raw instanceof Uint8Array
        ? raw
        : Uint8Array.from(raw);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

  const blob = new Blob([buffer], { type: "model/gltf-binary" });
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await loader.loadAsync(objectUrl);
  } catch (reason) {
    errors.push(reason instanceof Error ? reason.message : "blob 加载失败");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  try {
    return await loader.parseAsync(buffer, "");
  } catch (reason) {
    errors.push(reason instanceof Error ? reason.message : "内存解析失败");
  }

  throw new Error(errors.join("；"));
}

function refreshVrmMaterials(vrm: VRM) {
  vrm.scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material || typeof material !== "object") continue;
      material.needsUpdate = true;
      const maps = material as unknown as Record<string, { needsUpdate?: boolean } | undefined>;
      for (const key of [
        "map",
        "emissiveMap",
        "normalMap",
        "shadeMultiplyTexture",
        "matcapTexture",
        "rimMultiplyTexture",
      ]) {
        const texture = maps[key];
        if (texture) texture.needsUpdate = true;
      }
    }
  });
}
