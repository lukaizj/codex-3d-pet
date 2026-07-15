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
      gltf = await loader.loadAsync(convertFileSrc(filePath));
    } catch (reason) {
      const detail = reason instanceof Error ? `：${reason.message}` : "";
      throw new Error(`无法读取 VRM 文件。请确认文件仍在原位置，并允许应用访问该文件所在目录${detail}`);
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

    this.currentVrm?.scene.removeFromParent();
    this.currentVrm = vrm;
    this.rootBaseY = vrm.scene.position.y;
    this.scene.add(vrm.scene);
    this.applyScale();
    this.frameCharacter();
    this.shadow.visible = true;
    this.stateStartedAt = this.clock.elapsedTime;
    this.setPresentation(this.state);

    // 软提示：白模半成品提醒即可，不能拦截正常含材质色的角色
    return summarizeTextureIssue(vrm);
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

    const spine = humanoid.getNormalizedBoneNode("spine");
    const chest =
      humanoid.getNormalizedBoneNode("upperChest") ?? humanoid.getNormalizedBoneNode("chest");
    const head = humanoid.getNormalizedBoneNode("head");
    const leftArm = humanoid.getNormalizedBoneNode("leftUpperArm");
    const rightArm = humanoid.getNormalizedBoneNode("rightUpperArm");
    const rightLower = humanoid.getNormalizedBoneNode("rightLowerArm");

    if (spine) {
      spine.rotation.x = 0;
      spine.rotation.y = 0;
      spine.rotation.z = 0;
    }
    if (chest) chest.rotation.x = 0;
    if (head) {
      head.rotation.x = 0;
      head.rotation.y = 0;
      head.rotation.z = 0;
    }
    if (leftArm) {
      leftArm.rotation.z = 0;
      leftArm.rotation.x = 0;
      leftArm.rotation.y = 0;
    }
    if (rightArm) {
      rightArm.rotation.z = 0;
      rightArm.rotation.x = 0;
      rightArm.rotation.y = 0;
    }
    if (rightLower) rightLower.rotation.x = 0;

    let bob = 0;
    // 更慢、更小，避免「鬼畜」高频抽动
    const breathe = Math.sin((t * Math.PI * 2) / 3.8) * 0.018 * intensity;
    const sway = Math.sin((t * Math.PI * 2) / 5.2) * 0.045 * intensity;

    switch (this.state) {
      case "idle": {
        bob = Math.abs(Math.sin(t * 1.1)) * 0.006 * intensity;
        if (spine) {
          spine.rotation.z = sway;
          spine.rotation.x = breathe;
        }
        if (chest) chest.rotation.x = breathe * 0.8;
        if (head) head.rotation.y = Math.sin(t * 0.55) * 0.1 * intensity;
        if (leftArm) leftArm.rotation.z = 0.1 * intensity;
        if (rightArm) rightArm.rotation.z = -0.1 * intensity;
        break;
      }
      case "thinking": {
        if (spine) {
          spine.rotation.z = sway * 0.4;
          spine.rotation.x = breathe + 0.06 * intensity;
        }
        if (head) {
          head.rotation.x = 0.16 * intensity;
          head.rotation.y = Math.sin(t * 0.85) * 0.14 * intensity;
          head.rotation.z = 0.08 * intensity;
        }
        if (rightArm) {
          rightArm.rotation.z = -0.75 * intensity;
          rightArm.rotation.x = -0.85 * intensity + Math.sin(t * 1.6) * 0.06 * intensity;
          rightArm.rotation.y = 0.2 * intensity;
        }
        if (rightLower) rightLower.rotation.x = -0.55 * intensity;
        if (leftArm) leftArm.rotation.z = 0.18 * intensity;
        break;
      }
      case "working": {
        bob = Math.abs(Math.sin(t * 2.8)) * 0.018 * intensity;
        if (spine) {
          spine.rotation.z = Math.sin(t * 2.2) * 0.05 * intensity;
          spine.rotation.x = breathe + 0.05 * intensity;
        }
        if (head) head.rotation.x = Math.sin(t * 2.4) * 0.06 * intensity;
        if (leftArm) {
          leftArm.rotation.z = 0.35 * intensity + Math.sin(t * 3.2) * 0.18 * intensity;
          leftArm.rotation.x = Math.sin(t * 3.2 + 0.4) * 0.12 * intensity;
        }
        if (rightArm) {
          rightArm.rotation.z = -0.35 * intensity - Math.sin(t * 3.2 + 0.9) * 0.18 * intensity;
          rightArm.rotation.x = Math.sin(t * 3.2 + 1.3) * 0.12 * intensity;
        }
        break;
      }
      case "needs_attention": {
        const wave = Math.sin(t * 4.2);
        bob = Math.abs(wave) * 0.014 * intensity;
        if (spine) spine.rotation.z = sway * 0.9;
        if (head) {
          head.rotation.y = Math.sin(t * 1.8) * 0.18 * intensity;
          head.rotation.x = -0.06 * intensity;
        }
        if (rightArm) {
          rightArm.rotation.z = -1.15 * intensity;
          rightArm.rotation.x = -0.15 * intensity + wave * 0.4 * intensity;
          rightArm.rotation.y = 0.12 * intensity;
        }
        if (rightLower) rightLower.rotation.x = wave * 0.25 * intensity;
        if (leftArm) leftArm.rotation.z = 0.22 * intensity;
        break;
      }
      case "completed": {
        bob = Math.abs(Math.sin(t * Math.PI * 2.1)) * 0.035 * intensity;
        if (spine) {
          spine.rotation.x = -0.1 * intensity + breathe;
          spine.rotation.z = Math.sin(t * 2.4) * 0.06 * intensity;
        }
        if (head) head.rotation.x = -0.1 * intensity;
        if (leftArm) {
          leftArm.rotation.z = 1.05 * intensity;
          leftArm.rotation.x = -0.12 * intensity;
        }
        if (rightArm) {
          rightArm.rotation.z = -1.05 * intensity;
          rightArm.rotation.x = -0.12 * intensity;
        }
        break;
      }
      case "error": {
        if (spine) {
          spine.rotation.x = 0.18 * intensity + breathe * 0.5;
          spine.rotation.z = sway * 0.35;
        }
        if (chest) chest.rotation.x = 0.1 * intensity;
        if (head) {
          head.rotation.x = 0.28 * intensity;
          head.rotation.y = Math.sin(t * 0.7) * 0.06 * intensity;
        }
        if (leftArm) {
          leftArm.rotation.z = 0.85 * intensity;
          leftArm.rotation.x = -0.75 * intensity;
        }
        if (rightArm) {
          rightArm.rotation.z = -0.85 * intensity;
          rightArm.rotation.x = -0.75 * intensity;
        }
        break;
      }
    }

    this.currentVrm.scene.position.y = this.rootBaseY + bob;
    this.currentVrm.scene.rotation.y = 0;
    this.currentVrm.scene.rotation.z = 0;
  }
}

/** 粗查疑似白模半成品（仅软提示，不拦截加载） */
function summarizeTextureIssue(vrm: VRM): string | undefined {
  let meshCount = 0;
  let visiblyMateriated = 0;

  vrm.scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    meshCount += 1;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material || typeof material !== "object") continue;
      if (materialLooksDressed(material as unknown as Record<string, unknown>)) {
        visiblyMateriated += 1;
        break;
      }
    }
  });

  if (meshCount === 0) {
    return "角色没有可渲染网格，请换一个完整导出的 VRM。";
  }
  if (visiblyMateriated === 0 || visiblyMateriated / meshCount < 0.1) {
    return "角色看起来像白模（缺少贴图或材质色）。建议用 VRoid Studio「导出 VRM」成品；Blender 导出请确认已烘焙材质。";
  }
  return undefined;
}

function materialLooksDressed(material: Record<string, unknown>): boolean {
  if (
    material.map ||
    material.emissiveMap ||
    material.normalMap ||
    material.shadeMultiplyTexture ||
    material.litMultiplyTexture ||
    material.matcapTexture ||
    material.rimMultiplyTexture
  ) {
    return true;
  }

  const color = material.color ?? material.litFactor ?? material.shadeColorFactor;
  if (color && typeof color === "object" && "r" in color && "g" in color && "b" in color) {
    const { r, g, b } = color as { r: number; g: number; b: number };
    // 非近白即视为有材质色（纯色 VRM / 无位图也能正常显示）
    return !(r > 0.92 && g > 0.92 && b > 0.92);
  }

  return false;
}
