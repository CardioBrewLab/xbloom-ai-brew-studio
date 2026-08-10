/**
 * xBloom BLE 桥接层。
 *
 * Windows 默认使用 Python Bleak 调用系统 WinRT 蓝牙栈。项目原先使用
 * @abandonware/noble；在 Windows 11 + MediaTek 内置适配器上，系统栈能发现
 * xBloom，noble 同机扫描却持续超时。macOS/Linux 以及显式配置
 * XBLOOM_BLE_BACKEND=noble 时仍保留 noble 通道。
 *
 * 默认动作只“加载配方到机器”，由用户在机器上确认开始；不会把远程启动帧
 * 混进加载流程。日常使用仍优先走 xBloom 云端同步到手机 App。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  alignBlePourVolumes,
  buildLoadFrames,
  frameCancel,
  frameStatusQuery,
  grinderCloudToBle,
  XBLOOM_SERVICE_UUID,
} from "./ble-protocol.js";
import type { Recipe } from "./recipe-schema.js";

const SCAN_TIMEOUT_MS = Number(process.env.XBLOOM_BLE_SCAN_TIMEOUT_MS || 15000);
const HELPER_TIMEOUT_MS = Number(process.env.XBLOOM_BLE_HELPER_TIMEOUT_MS || 45000);
const FRAME_GAP_MS = 400;
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "../../..");
const helperPath = path.join(projectRoot, "server", "python", "xbloom_ble_helper.py");
const venvPython = path.join(projectRoot, ".venv-ble", "Scripts", "python.exe");

export type BleBackend = "python-bleak" | "noble";

export interface BleStatus {
  available: boolean;
  connected: boolean;
  /** 已完成一次发现；Python on-demand 通道不会长期占用机器连接。 */
  ready: boolean;
  backend: BleBackend;
  device?: string;
  reason?: string;
  lastError?: string;
  supportsRemoteStart: boolean;
  guidance: string;
}

interface HelperResult {
  ok: boolean;
  message?: string;
  failureKind?: string;
  found?: boolean;
  loaded?: boolean;
  requiresMachineConfirmation?: boolean;
  device?: string;
  rssi?: number;
  discoveredCount?: number;
}

interface BleConnection {
  send: (buf: Buffer) => Promise<void>;
  disconnect: () => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUuid(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("-", "");
}

export function matchesXBloomAdvertisement(advertisement: {
  localName?: string | null;
  serviceUuids?: unknown[] | null;
}): boolean {
  const name = (advertisement.localName ?? "").trim().toUpperCase();
  const target = normalizeUuid(XBLOOM_SERVICE_UUID);
  const services = advertisement.serviceUuids ?? [];
  return (
    name.startsWith("XBLOOM") ||
    services.some((uuid) => {
      const normalized = normalizeUuid(uuid);
      return normalized === target || normalized === "e0ff";
    })
  );
}

function pythonRecipe(recipe: Recipe): Record<string, unknown> {
  const volumes = alignBlePourVolumes(recipe);
  return {
    name: recipe.name,
    dose_g: Math.round(recipe.doseGrams),
    grind: recipe.isSetGrinderSize === 2 ? 0 : grinderCloudToBle(recipe.grinderSize),
    stage_temps: [110, 90],
    pours: recipe.pours.map((pour, index) => ({
      label: pour.theName,
      ml: volumes[index],
      temp_c: Math.round(pour.temperature),
      pattern: pour.pattern === "circular" ? "ring" : pour.pattern,
      agitation: pour.pattern === "spiral" && Boolean(pour.vibBefore || pour.vibAfter),
      pause_s: Math.round(pour.pausing),
      rpm: pour.pattern === "center" ? 0 : Math.round(recipe.rpm),
      flow_ml_s: Math.round(pour.flowRate * 10) / 10,
    })),
  };
}

function runHelper(
  command: "probe" | "scan" | "load" | "cancel",
  recipe?: Recipe,
): Promise<HelperResult> {
  return new Promise((resolve, reject) => {
    const python =
      process.env.XBLOOM_BLE_PYTHON?.trim() || (existsSync(venvPython) ? venvPython : "python");
    const child = spawn(python, [helperPath], {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, result?: HelperResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result ?? { ok: false, message: "BLE helper 未返回结果" });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`BLE helper 超时（${Math.round(HELPER_TIMEOUT_MS / 1000)}s）`));
    }, HELPER_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-1_000_000);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-20_000);
    });
    child.on("error", (error) => finish(error));
    child.on("close", () => {
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      if (!line) {
        finish(new Error(stderr.trim().split(/\r?\n/).at(-1) || "BLE helper 启动失败"));
        return;
      }
      try {
        finish(undefined, JSON.parse(line) as HelperResult);
      } catch {
        finish(new Error("BLE helper 返回格式异常"));
      }
    });
    child.stdin.end(
      JSON.stringify({
        command,
        timeout: Math.max(3, Math.round(SCAN_TIMEOUT_MS / 1000)),
        ...(recipe ? { recipe: pythonRecipe(recipe) } : {}),
      }),
    );
  });
}

class BleBridge {
  private readonly backend: BleBackend;
  private noble: any = null;
  private nobleLoaded = false;
  private available = true;
  private reason?: string;
  private connected = false;
  private ready = false;
  private connecting = false;
  private deviceName?: string;
  private lastError?: string;
  private conn: BleConnection | null = null;

  constructor() {
    const requested = process.env.XBLOOM_BLE_BACKEND?.trim().toLowerCase();
    this.backend =
      requested === "noble" || (requested !== "python" && process.platform !== "win32")
        ? "noble"
        : "python-bleak";
    if (this.backend === "python-bleak") {
      if (!existsSync(helperPath)) {
        this.available = false;
        this.reason = "BLE helper 文件缺失";
      }
      return;
    }
    try {
      createRequire(import.meta.url).resolve("@abandonware/noble");
    } catch (error) {
      this.available = false;
      this.reason = `@abandonware/noble 未就绪：${(error as Error).message.split("\n")[0]}`;
    }
  }

  status(): BleStatus {
    return {
      available: this.available,
      connected: this.connected,
      ready: this.ready || this.connected,
      backend: this.backend,
      ...(this.deviceName ? { device: this.deviceName } : {}),
      ...(this.reason ? { reason: this.reason } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      supportsRemoteStart: false,
      guidance: "日常使用请同步到手机 xBloom App；BLE 仅用于本机协议实验。",
    };
  }

  async connect(): Promise<HelperResult> {
    if (!this.available) return { ok: false, message: this.reason ?? "BLE 后端未就绪" };
    if (this.connecting) return { ok: false, message: "正在检测附近设备，请稍候" };
    this.connecting = true;
    this.lastError = undefined;
    try {
      if (this.backend === "python-bleak") {
        const result = await runHelper("scan");
        if (result.ok) {
          this.ready = true;
          this.deviceName = result.device;
        } else {
          this.lastError = result.message;
        }
        return result;
      }
      const result = await this.scanAndConnectNoble();
      this.conn = result.conn;
      this.deviceName = result.name;
      this.connected = true;
      this.ready = true;
      return { ok: true, found: true, device: result.name };
    } catch (error) {
      this.lastError = (error as Error).message;
      return { ok: false, message: this.lastError };
    } finally {
      this.connecting = false;
    }
  }

  /** 加载配方到机器，启动动作留给机器端确认。 */
  async brew(recipe: Recipe): Promise<HelperResult> {
    if (!this.available) return { ok: false, message: this.reason ?? "BLE 后端未就绪" };
    this.lastError = undefined;
    try {
      if (this.backend === "python-bleak") {
        const result = await runHelper("load", recipe);
        if (result.ok) {
          this.ready = true;
          this.deviceName = result.device;
        } else {
          this.lastError = result.message;
        }
        return result;
      }
      if (!this.connected || !this.conn) return { ok: false, message: "请先连接设备" };
      const frames = buildLoadFrames(recipe);
      await this.conn.send(frames[0].buf);
      await sleep(500);
      await this.conn.send(frameStatusQuery());
      await sleep(2000);
      for (const frame of frames.slice(1)) {
        await this.conn.send(frame.buf);
        await sleep(FRAME_GAP_MS);
      }
      return {
        ok: true,
        loaded: true,
        requiresMachineConfirmation: true,
        device: this.deviceName,
        message: "配方已加载到机器，请在机器上确认开始。",
      };
    } catch (error) {
      this.lastError = (error as Error).message;
      return { ok: false, message: `BLE 加载失败：${this.lastError}` };
    }
  }

  async stop(): Promise<HelperResult> {
    try {
      if (this.backend === "python-bleak") return await runHelper("cancel");
      if (this.connected && this.conn) await this.conn.send(frameCancel());
      return { ok: true, message: "已发送停止指令" };
    } catch (error) {
      return { ok: false, message: `停止指令发送失败：${(error as Error).message}` };
    }
  }

  private ensureNoble(): void {
    if (this.nobleLoaded || !this.available) return;
    try {
      this.noble = createRequire(import.meta.url)("@abandonware/noble");
      this.nobleLoaded = true;
    } catch (error) {
      this.available = false;
      this.reason = `@abandonware/noble 加载失败：${(error as Error).message.split("\n")[0]}`;
      throw error;
    }
  }

  private scanAndConnectNoble(): Promise<{ name: string; conn: BleConnection }> {
    this.ensureNoble();
    const noble = this.noble;
    return new Promise((resolve, reject) => {
      let settled = false;
      let discoveredCount = 0;
      const cleanup = (): void => {
        clearTimeout(timer);
        noble.removeListener("stateChange", onStateChange);
        noble.removeListener("discover", onDiscover);
        Promise.resolve(noble.stopScanningAsync?.() ?? noble.stopScanning?.()).catch(() => {});
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const succeed = (value: { name: string; conn: BleConnection }): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const beginScan = (): void => {
        Promise.resolve(
          noble.startScanningAsync?.([], false) ?? noble.startScanning?.([], false),
        ).catch(fail);
      };
      const onStateChange = (state: string): void => {
        if (state === "poweredOn") beginScan();
        else if (["poweredOff", "unsupported", "unauthorized"].includes(state)) {
          fail(new Error(`蓝牙适配器状态：${state}`));
        }
      };
      const onDiscover = (peripheral: any): void => {
        discoveredCount += 1;
        const advertisement = peripheral?.advertisement ?? {};
        if (!matchesXBloomAdvertisement(advertisement)) return;
        Promise.resolve(noble.stopScanningAsync?.() ?? noble.stopScanning?.())
          .then(() => peripheral.connectAsync())
          .then(() => peripheral.discoverAllServicesAndCharacteristicsAsync())
          .then(({ characteristics }: { characteristics: any[] }) => {
            const write = characteristics.find(
              (item) =>
                normalizeUuid(item.uuid).endsWith("ffe100001000800000805f9b34fb") ||
                normalizeUuid(item.uuid) === "ffe1",
            );
            if (!write) throw new Error("机器未暴露 ffe1 写入特征");
            peripheral.on?.("disconnect", () => {
              this.connected = false;
              this.conn = null;
            });
            succeed({
              name: advertisement.localName || "xBloom Studio",
              conn: {
                send: (buf) =>
                  new Promise<void>((done, rejectWrite) => {
                    // noble 的第三参数 true 才是 write-without-response；ffe1 只接受该模式。
                    write.write(buf, true, (error?: Error) =>
                      error ? rejectWrite(error) : done(),
                    );
                  }),
                disconnect: () => peripheral.disconnectAsync?.().catch?.(() => {}),
              },
            });
          })
          .catch(fail);
      };
      const timer = setTimeout(() => {
        fail(
          new Error(`扫描超时：共看到 ${discoveredCount} 台 BLE 设备，但未识别到可连接的 xBloom`),
        );
      }, SCAN_TIMEOUT_MS);
      noble.on("stateChange", onStateChange);
      noble.on("discover", onDiscover);
      if (noble.state === "poweredOn") beginScan();
    });
  }
}

export const bleBridge = new BleBridge();
