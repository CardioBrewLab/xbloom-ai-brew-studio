/**
 * xBloom Studio BLE 协议纯函数层。
 *
 * 字节布局依据 2026 年社区从官方 App HCI 抓包复现、并在 Studio
 * V12.0D.500 上往返验证的协议：
 *   58 01 01 | opcode(u8) | seq(u8) | length(u16le) | 00 00 | payload | crc16(u16le)
 *
 * 关键产品边界：加载配方与启动冲煮严格分离。buildLoadFrames 只生成
 * a4/a6/a8/41(或 44) 四个“加载”帧，不包含会出热水的 commit/start。
 */
import type { Recipe } from "./recipe-schema.js";

export const XBLOOM_SERVICE_UUID = "0000e0ff-3c17-d293-8e48-14fe2e4da212";
export const XBLOOM_COMMAND_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb";
export const XBLOOM_STATUS_UUID = "0000ffe2-0000-1000-8000-00805f9b34fb";

export const BLE_LOAD_SEQUENCE = 0x1f;
export const BLE_BREW_SEQUENCE = 0x9e;
export const BLE_RATIO_MAX = 25.5;
export const BLE_NO_GRIND_WIRE = 0xfe;

export const BLE_OPCODE = {
  SESSION_START: 0xa4,
  DOSE: 0xa6,
  STAGE_TEMPS: 0xa8,
  POURS_WITH_GRIND: 0x41,
  POURS_NO_GRIND: 0x44,
  STATUS_QUERY: 0x56,
  COMMIT: 0x42,
  START: 0x46,
  CANCEL: 0x47,
} as const;

export interface BleFrameStep {
  buf: Buffer;
  label: string;
}

/** CRC-16/KERMIT；标准 check 向量 `123456789` = 0x2189。 */
export function crc16Kermit(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}

/** 构建真机已验证的单字节 opcode 帧。 */
export function buildBleFrame(opcode: number, sequence: number, payload: Uint8Array): Buffer {
  const frame = Buffer.alloc(9 + payload.length + 2);
  frame.set([0x58, 0x01, 0x01, opcode & 0xff, sequence & 0xff], 0);
  frame.writeUInt16LE(frame.length, 5);
  frame[7] = 0;
  frame[8] = 0;
  frame.set(payload, 9);
  frame.writeUInt16LE(crc16Kermit(frame.subarray(0, -2)), frame.length - 2);
  return frame;
}

/** 内部/云端 40–120 标尺 → 机器 1–80 标尺。 */
export function grinderCloudToBle(cloudGrinder: number): number {
  const clamped = Math.min(120, Math.max(40, cloudGrinder));
  return Math.round(1 + ((clamped - 40) * 79) / 80);
}

/**
 * 把浮点分段对齐为整数毫升，同时确保总和等于 grandWater。
 * 使用最大余数法，避免逐段 Math.round 造成总量漂移。
 */
export function alignBlePourVolumes(recipe: Recipe): number[] {
  const target = Math.round(recipe.grandWater);
  const base = recipe.pours.map((pour) => Math.max(1, Math.floor(pour.volume)));
  let delta = target - base.reduce((sum, value) => sum + value, 0);

  if (delta > 0) {
    const order = recipe.pours
      .map((pour, index) => ({ index, fraction: pour.volume - Math.floor(pour.volume) }))
      .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
    for (let cursor = 0; delta > 0; cursor++, delta--) {
      base[order[cursor % order.length].index] += 1;
    }
  } else if (delta < 0) {
    const order = base
      .map((value, index) => ({ index, value }))
      .sort((a, b) => b.value - a.value || a.index - b.index);
    let cursor = 0;
    while (delta < 0) {
      const candidate = order[cursor % order.length].index;
      if (base[candidate] > 1) {
        base[candidate] -= 1;
        delta += 1;
      }
      cursor += 1;
      if (cursor > order.length * Math.max(1, target + 1)) {
        throw new Error("BLE 分段无法对齐到目标总水量");
      }
    }
  }
  return base;
}

function sessionStartPayload(): Buffer {
  return Buffer.from("01b900000001000000", "hex");
}

function dosePayload(doseGrams: number): Buffer {
  const payload = Buffer.alloc(13);
  payload[0] = 0x01;
  payload[9] = Math.round(doseGrams) & 0xff;
  return payload;
}

function stageTempsPayload(first = 110, second = 90): Buffer {
  const payload = Buffer.alloc(9);
  payload[0] = 0x01;
  payload.writeFloatLE(first, 1);
  payload.writeFloatLE(second, 5);
  return payload;
}

function patternBytes(pour: Recipe["pours"][number]): [number, number] {
  if (pour.pattern === "center") return [0x00, 0x01];
  if (pour.pattern === "circular") return [0x01, 0x00];
  return [0x02, pour.vibBefore || pour.vibAfter ? 0x02 : 0x00];
}

function pourSegments(recipe: Recipe, volumes: number[]): Buffer {
  const chunks: Buffer[] = [];
  recipe.pours.forEach((pour, index) => {
    const [pattern, agitation] = patternBytes(pour);
    let remaining = volumes[index];
    while (remaining > 127) {
      chunks.push(Buffer.from([127, Math.round(pour.temperature), pattern, agitation]));
      remaining -= 127;
    }
    chunks.push(
      Buffer.from([
        remaining & 0xff,
        Math.round(pour.temperature) & 0xff,
        pattern,
        agitation,
        (256 - Math.round(pour.pausing)) & 0xff,
        0x00,
        index === 0 ? Math.round(recipe.rpm) & 0xff : 0x00,
        Math.round(pour.flowRate * 10) & 0xff,
      ]),
    );
  });
  return Buffer.concat(chunks);
}

export function buildPoursPayload(recipe: Recipe): {
  opcode: number;
  payload: Buffer;
  volumes: number[];
} {
  if (!Number.isFinite(recipe.doseGrams) || recipe.doseGrams <= 0) {
    throw new Error(`BLE 编码要求正粉量，收到 ${recipe.doseGrams}`);
  }
  const volumes = alignBlePourVolumes(recipe);
  const total = volumes.reduce((sum, value) => sum + value, 0);
  const ratio = total / recipe.doseGrams;
  if (Math.round(ratio * 10) / 10 > BLE_RATIO_MAX) {
    throw new Error(`粉水比 1:${ratio.toFixed(1)} 超出 BLE 单字节上限 1:${BLE_RATIO_MAX}`);
  }
  const segments = pourSegments(recipe, volumes);
  if (segments.length > 255) throw new Error("BLE 分段载荷超过单字节长度上限");

  const noGrind = recipe.isSetGrinderSize === 2;
  const grind = noGrind ? BLE_NO_GRIND_WIRE : grinderCloudToBle(recipe.grinderSize);
  const tail = Math.round(ratio * 10) & 0xff;
  const payload = Buffer.concat([
    Buffer.from([0x01, segments.length & 0xff]),
    segments,
    Buffer.from([grind, tail]),
  ]);
  return {
    opcode: noGrind ? BLE_OPCODE.POURS_NO_GRIND : BLE_OPCODE.POURS_WITH_GRIND,
    payload,
    volumes,
  };
}

/** 只加载配方；返回值从设计上不含 commit/start/cancel。 */
export function buildLoadFrames(recipe: Recipe): BleFrameStep[] {
  const pours = buildPoursPayload(recipe);
  const frames: BleFrameStep[] = [
    {
      buf: buildBleFrame(BLE_OPCODE.SESSION_START, BLE_LOAD_SEQUENCE, sessionStartPayload()),
      label: "SESSION_START(a4)",
    },
    {
      buf: buildBleFrame(BLE_OPCODE.DOSE, BLE_LOAD_SEQUENCE, dosePayload(recipe.doseGrams)),
      label: `DOSE(a6) ${Math.round(recipe.doseGrams)}g`,
    },
    {
      buf: buildBleFrame(BLE_OPCODE.STAGE_TEMPS, BLE_LOAD_SEQUENCE, stageTempsPayload()),
      label: "STAGE_TEMPS(a8)",
    },
    {
      buf: buildBleFrame(pours.opcode, BLE_LOAD_SEQUENCE, pours.payload),
      label: `${pours.opcode === BLE_OPCODE.POURS_NO_GRIND ? "POURS_NO_GRIND(44)" : "POURS(41)"} ${pours.volumes.join("+")}ml`,
    },
  ];
  for (const frame of frames) {
    if ([BLE_OPCODE.COMMIT, BLE_OPCODE.START, BLE_OPCODE.CANCEL].includes(frame.buf[3] as never)) {
      throw new Error("加载序列混入了冲煮控制帧");
    }
  }
  return frames;
}

export function frameStatusQuery(): Buffer {
  return buildBleFrame(BLE_OPCODE.STATUS_QUERY, BLE_LOAD_SEQUENCE, Buffer.from([0x01]));
}

export function frameCommit(): Buffer {
  return buildBleFrame(BLE_OPCODE.COMMIT, BLE_LOAD_SEQUENCE, Buffer.from([0x01]));
}

export function frameStart(): Buffer {
  return buildBleFrame(BLE_OPCODE.START, BLE_BREW_SEQUENCE, Buffer.from([0x01]));
}

export function frameCancel(): Buffer {
  return buildBleFrame(BLE_OPCODE.CANCEL, BLE_BREW_SEQUENCE, Buffer.from([0x01]));
}
