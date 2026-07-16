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
    // 本角色：左臂 z 负值 = 垂下，正值 = 举起（与先前假设相反）
    // ±1.38 + 软肘：贴身但不贴死裙摆
    leftArmX: 0.08,
    leftArmY: 0.03,
    leftArmZ: -1.38,
    rightArmX: 0.08,
    rightArmY: -0.03,
    rightArmZ: 1.38,
    leftLowerX: -0.42,
    rightLowerX: -0.38,
    leftHandZ: 0.08,
    rightHandZ: -0.08,
    leftShoulderZ: 0,
    rightShoulderZ: 0,
    leftUpperLegX: 0,
    rightUpperLegX: 0,
    leftLowerLegX: 0,
    rightLowerLegX: 0,
    hipsY: 0,
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

      if (state === "idle") {
        expression.setValue("relaxed", 0.35);
        expression.setValue("happy", 0.18);
      }
      if (state === "completed") expression.setValue("happy", 0.85);
      if (state === "error") expression.setValue("sad", 0.75);
      if (state === "needs_attention") expression.setValue("surprised", 0.7);
      if (state === "thinking") expression.setValue("relaxed", 0.45);
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
    // 实测本角色：左臂 z 负值=垂下，正值=上举（T 姿 z≈0）
    // ±1.5 会贴死裙摆显得僵；±1.38 + 软肘弯更自然
    const L_DOWN = -1.38;
    const R_DOWN = 1.38;
    const breathe = Math.sin((t * Math.PI * 2) / 4.8) * 0.014 * intensity;
    const sway = Math.sin((t * Math.PI * 2) / 8.0) * 0.022 * intensity;
    const since = Math.max(0, t - this.stateStartedAt);

    const target = {
      spineX: 0,
      spineY: 0,
      spineZ: 0,
      chestX: 0,
      headX: 0,
      headY: 0,
      headZ: 0,
      leftArmX: 0.08,
      leftArmY: 0.03,
      leftArmZ: L_DOWN,
      rightArmX: 0.08,
      rightArmY: -0.03,
      rightArmZ: R_DOWN,
      leftLowerX: -0.42,
      rightLowerX: -0.38,
      leftHandZ: 0.12,
      rightHandZ: -0.1,
      leftShoulderZ: 0.02,
      rightShoulderZ: -0.02,
      leftUpperLegX: 0,
      rightUpperLegX: 0,
      leftLowerLegX: 0,
      rightLowerLegX: 0,
      hipsY: 0,
      bob: 0,
    };

    switch (this.state) {
      case "idle": {
        // 贴身软垂臂 + 不对称肘弯；不要 *.72 半举（看起来像僵硬 A 姿）
        const armSwing = Math.sin(t * 0.6) * 0.015 * intensity;
        target.spineZ = sway + 0.04 * intensity;
        target.spineX = breathe - 0.02;
        target.chestX = breathe * 0.4;
        target.hipsY = 0.09 * intensity + Math.sin(t * 0.36) * 0.02 * intensity;
        target.headY = Math.sin(t * 0.28) * 0.07 * intensity;
        target.headX = breathe * 0.25 - 0.02;
        target.headZ = 0.1 * intensity + Math.sin(t * 0.2) * 0.015 * intensity;
        target.leftArmZ = L_DOWN + armSwing;
        target.rightArmZ = R_DOWN - armSwing * 0.55;
        target.leftArmX = 0.12;
        target.rightArmX = 0.06;
        target.leftArmY = 0.08;
        target.rightArmY = -0.05;
        target.leftLowerX = -0.55;
        target.rightLowerX = -0.32;
        target.leftHandZ = 0.16;
        target.rightHandZ = -0.06;
        target.leftShoulderZ = 0.045;
        target.rightShoulderZ = -0.02;
        target.leftUpperLegX = -0.04 * intensity;
        target.rightUpperLegX = 0.03 * intensity;
        target.leftLowerLegX = 0.08 * intensity;
        target.rightLowerLegX = 0.02 * intensity;
        target.bob = Math.sin(t * 0.78) * 0.002 * intensity;
        break;
      }
      case "thinking": {
        target.spineX = breathe + 0.04 * intensity;
        target.spineZ = -0.05 * intensity + sway * 0.25;
        target.hipsY = 0.08 * intensity;
        target.headX = 0.1 * intensity;
        target.headY = 0.18 * intensity + Math.sin(t * 0.6) * 0.035 * intensity;
        target.headZ = 0.1 * intensity;
        target.rightArmZ = R_DOWN * 0.22;
        target.rightArmX = -0.85 * intensity + Math.sin(t * 1.1) * 0.025 * intensity;
        target.rightArmY = -0.48 * intensity;
        target.rightLowerX = -1.35 * intensity;
        target.rightHandZ = -0.25 * intensity;
        target.rightShoulderZ = -0.12 * intensity;
        target.leftArmZ = L_DOWN * 0.98;
        target.leftArmX = 0.08;
        target.leftArmY = 0.04;
        target.leftLowerX = -0.4;
        target.leftUpperLegX = -0.03;
        target.rightUpperLegX = 0.02;
        target.bob = Math.sin(t * 0.65) * 0.0018 * intensity;
        break;
      }
      case "working": {
        const tap = Math.sin(t * 4.5);
        target.spineX = 0.1 * intensity + breathe;
        target.spineZ = Math.sin(t * 1.4) * 0.018 * intensity;
        target.chestX = 0.06 * intensity;
        target.headX = 0.2 * intensity;
        target.headY = Math.sin(t * 1.0) * 0.035 * intensity;
        target.leftArmZ = L_DOWN * 0.55;
        target.leftArmX = -0.55 * intensity + tap * 0.05 * intensity;
        target.leftArmY = 0.28 * intensity;
        target.leftLowerX = -1.2 * intensity;
        target.rightArmZ = R_DOWN * 0.55;
        target.rightArmX = -0.52 * intensity - tap * 0.05 * intensity;
        target.rightArmY = -0.26 * intensity;
        target.rightLowerX = -1.15 * intensity;
        target.leftShoulderZ = 0.06;
        target.rightShoulderZ = -0.06;
        target.leftUpperLegX = -0.02;
        target.rightUpperLegX = -0.02;
        target.bob = Math.abs(Math.sin(t * 2.0)) * 0.004 * intensity;
        break;
      }
      case "needs_attention": {
        const wave = Math.sin(t * 4.2);
        const bounce = Math.abs(Math.sin(t * 2.6));
        target.spineZ = sway * 0.7 + 0.04 * intensity;
        target.spineX = -0.02 * intensity;
        target.hipsY = -0.04 * intensity;
        target.headY = Math.sin(t * 1.5) * 0.1 * intensity;
        target.headX = -0.04 * intensity;
        target.rightArmZ = R_DOWN * 0.28 + wave * 0.1 * intensity;
        target.rightArmX = -0.2 * intensity;
        target.rightArmY = -0.75 * intensity + wave * 0.15 * intensity;
        target.rightLowerX = -0.5 * intensity + wave * 0.12 * intensity;
        target.rightShoulderZ = -0.2 * intensity;
        target.leftArmZ = L_DOWN * 0.98;
        target.leftArmX = 0.07;
        target.leftLowerX = -0.38;
        target.bob = bounce * 0.01 * intensity;
        break;
      }
      case "completed": {
        const hop = Math.abs(Math.sin(t * Math.PI * 1.8));
        const sparkle = Math.sin(t * 2.6);
        target.spineX = -0.06 * intensity + breathe;
        target.spineZ = sparkle * 0.035 * intensity;
        target.chestX = -0.03 * intensity;
        target.headX = -0.08 * intensity;
        target.headY = sparkle * 0.05 * intensity;
        target.leftArmZ = L_DOWN * 0.4;
        target.leftArmX = -0.7 * intensity;
        target.leftArmY = 0.38 * intensity;
        target.leftLowerX = -1.2 * intensity;
        target.rightArmZ = R_DOWN * 0.4;
        target.rightArmX = -0.7 * intensity;
        target.rightArmY = -0.38 * intensity;
        target.rightLowerX = -1.2 * intensity;
        target.leftShoulderZ = 0.1;
        target.rightShoulderZ = -0.1;
        target.leftUpperLegX = -0.06 * intensity;
        target.rightUpperLegX = -0.06 * intensity;
        target.leftLowerLegX = 0.1 * intensity;
        target.rightLowerLegX = 0.1 * intensity;
        target.bob = hop * 0.022 * intensity;
        break;
      }
      case "error": {
        target.spineX = 0.12 * intensity + breathe * 0.35;
        target.spineZ = sway * 0.15;
        target.chestX = 0.05 * intensity;
        target.headX = 0.24 * intensity;
        target.headY = Math.sin(t * 0.45) * 0.025 * intensity;
        target.headZ = 0.05 * intensity;
        target.leftArmZ = L_DOWN * 0.55;
        target.leftArmX = -0.4 * intensity;
        target.leftArmY = 0.32 * intensity;
        target.leftLowerX = -0.95 * intensity;
        target.rightArmZ = R_DOWN * 0.55;
        target.rightArmX = -0.4 * intensity;
        target.rightArmY = -0.32 * intensity;
        target.rightLowerX = -0.95 * intensity;
        target.leftShoulderZ = 0.08;
        target.rightShoulderZ = -0.08;
        target.leftUpperLegX = 0.02;
        target.rightUpperLegX = 0.02;
        target.bob = Math.sin(t * 0.75) * 0.0012 * intensity;
        break;
      }
    }

    const blend = since < 0.4 ? 0.2 : 0.1;
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
    p.leftHandZ += (target.leftHandZ - p.leftHandZ) * blend;
    p.rightHandZ += (target.rightHandZ - p.rightHandZ) * blend;
    p.leftShoulderZ += (target.leftShoulderZ - p.leftShoulderZ) * blend;
    p.rightShoulderZ += (target.rightShoulderZ - p.rightShoulderZ) * blend;
    p.leftUpperLegX += (target.leftUpperLegX - p.leftUpperLegX) * blend;
    p.rightUpperLegX += (target.rightUpperLegX - p.rightUpperLegX) * blend;
    p.leftLowerLegX += (target.leftLowerLegX - p.leftLowerLegX) * blend;
    p.rightLowerLegX += (target.rightLowerLegX - p.rightLowerLegX) * blend;
    p.hipsY += (target.hipsY - p.hipsY) * blend;
    p.bob += (target.bob - p.bob) * blend;

    const hips = humanoid.getNormalizedBoneNode("hips");
    const spine = humanoid.getNormalizedBoneNode("spine");
    const chest =
      humanoid.getNormalizedBoneNode("upperChest") ?? humanoid.getNormalizedBoneNode("chest");
    const head = humanoid.getNormalizedBoneNode("head");
    const leftShoulder = humanoid.getNormalizedBoneNode("leftShoulder");
    const rightShoulder = humanoid.getNormalizedBoneNode("rightShoulder");
    const leftArm = humanoid.getNormalizedBoneNode("leftUpperArm");
    const rightArm = humanoid.getNormalizedBoneNode("rightUpperArm");
    const leftLower = humanoid.getNormalizedBoneNode("leftLowerArm");
    const rightLower = humanoid.getNormalizedBoneNode("rightLowerArm");
    const leftHand = humanoid.getNormalizedBoneNode("leftHand");
    const rightHand = humanoid.getNormalizedBoneNode("rightHand");
    const leftUpperLeg = humanoid.getNormalizedBoneNode("leftUpperLeg");
    const rightUpperLeg = humanoid.getNormalizedBoneNode("rightUpperLeg");
    const leftLowerLeg = humanoid.getNormalizedBoneNode("leftLowerLeg");
    const rightLowerLeg = humanoid.getNormalizedBoneNode("rightLowerLeg");

    if (hips) hips.rotation.y = p.hipsY;
    if (spine) spine.rotation.set(p.spineX, p.spineY, p.spineZ);
    if (chest) chest.rotation.x = p.chestX;
    if (head) head.rotation.set(p.headX, p.headY, p.headZ);
    if (leftShoulder) leftShoulder.rotation.z = p.leftShoulderZ;
    if (rightShoulder) rightShoulder.rotation.z = p.rightShoulderZ;
    if (leftArm) leftArm.rotation.set(p.leftArmX, p.leftArmY, p.leftArmZ);
    if (rightArm) rightArm.rotation.set(p.rightArmX, p.rightArmY, p.rightArmZ);
    if (leftLower) leftLower.rotation.x = p.leftLowerX;
    if (rightLower) rightLower.rotation.x = p.rightLowerX;
    if (leftHand) leftHand.rotation.z = p.leftHandZ;
    if (rightHand) rightHand.rotation.z = p.rightHandZ;
    if (leftUpperLeg) leftUpperLeg.rotation.x = p.leftUpperLegX;
    if (rightUpperLeg) rightUpperLeg.rotation.x = p.rightUpperLegX;
    if (leftLowerLeg) leftLowerLeg.rotation.x = p.leftLowerLegX;
    if (rightLowerLeg) rightLowerLeg.rotation.x = p.rightLowerLegX;

    this.currentVrm.scene.position.y = this.rootBaseY + p.bob;
    // 轻微侧身，正面站桩会显得更呆
    this.currentVrm.scene.rotation.y = 0.18;
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
