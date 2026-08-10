/** Byte-for-byte regression tests for the hardware-verified xBloom protocol. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchesXBloomAdvertisement } from "../src/lib/ble-bridge.js";
import {
  BLE_NO_GRIND_WIRE,
  BLE_OPCODE,
  alignBlePourVolumes,
  buildBleFrame,
  buildLoadFrames,
  buildPoursPayload,
  crc16Kermit,
  frameCancel,
  frameCommit,
  frameStart,
  grinderCloudToBle,
} from "../src/lib/ble-protocol.js";
import { RecipeSchema, type Recipe } from "../src/lib/recipe-schema.js";

function simpleRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return RecipeSchema.parse({
    name: "Verified BLE",
    cupType: "xdripper",
    doseGrams: 16,
    grinderSize: 61, // cloud 61 -> device 22
    rpm: 100,
    grandWater: 150,
    pours: [
      { volume: 35, temperature: 90, flowRate: 3.0, pattern: "spiral", pausing: 40 },
      { volume: 115, temperature: 90, flowRate: 3.0, pattern: "spiral", pausing: 5 },
    ],
    ...overrides,
  });
}

describe("BLE discovery", () => {
  it("matches the vendor service UUID even when the local name is absent", () => {
    assert.equal(
      matchesXBloomAdvertisement({ serviceUuids: ["0000E0FF-3C17-D293-8E48-14FE2E4DA212"] }),
      true,
    );
    assert.equal(matchesXBloomAdvertisement({ serviceUuids: ["e0ff"] }), true);
  });

  it("matches the advertised XBLOOM name and ignores unrelated devices", () => {
    assert.equal(matchesXBloomAdvertisement({ localName: "XBLOOM 123456" }), true);
    assert.equal(matchesXBloomAdvertisement({ localName: "Mijia Scale", serviceUuids: [] }), false);
  });
});

describe("verified BLE frame format", () => {
  it("keeps the standard CRC-16/KERMIT vector", () => {
    assert.equal(crc16Kermit(Buffer.from("123456789", "ascii")), 0x2189);
  });

  it("stores opcode/sequence/length and a valid trailing CRC", () => {
    const frame = buildBleFrame(0xa6, 0x1f, Buffer.alloc(13));
    assert.deepEqual(
      [...frame.subarray(0, 9)],
      [0x58, 0x01, 0x01, 0xa6, 0x1f, 0x18, 0x00, 0x00, 0x00],
    );
    assert.equal(frame.readUInt16LE(frame.length - 2), crc16Kermit(frame.subarray(0, -2)));
  });

  it("matches commit/start/cancel bytes captured from the official app", () => {
    assert.equal(frameCommit().toString("hex"), "580101421f0c000000017fcf");
    assert.equal(frameStart().toString("hex"), "580101469e0c0000000180a1");
    assert.equal(frameCancel().toString("hex"), "580101479e0c00000001553e");
  });
});

describe("load-only recipe sequence", () => {
  it("matches the four hardware-verified reference frames byte for byte", () => {
    const actual = buildLoadFrames(simpleRecipe()).map((step) => step.buf.toString("hex"));
    assert.deepEqual(actual, [
      "580101a41f1400000001b900000001000000bdd1",
      "580101a61f1800000001000000000000000010000000088c",
      "580101a81f14000000010000dc420000b44221a1",
      "580101411f1f0000000110235a0200d800641e735a0200fb00001e165ed656",
    ]);
  });

  it("contains a4/a6/a8/41 only, never commit/start/cancel", () => {
    const opcodes = buildLoadFrames(simpleRecipe()).map((step) => step.buf[3]);
    assert.deepEqual(opcodes, [0xa4, 0xa6, 0xa8, 0x41]);
    for (const opcode of opcodes) {
      assert.ok(
        ![BLE_OPCODE.COMMIT, BLE_OPCODE.START, BLE_OPCODE.CANCEL].includes(opcode as never),
      );
    }
  });

  it("uses opcode 44 and FE sentinel for pre-ground coffee", () => {
    const pours = buildPoursPayload(simpleRecipe({ isSetGrinderSize: 2 }));
    assert.equal(pours.opcode, BLE_OPCODE.POURS_NO_GRIND);
    assert.equal(pours.payload.at(-2), BLE_NO_GRIND_WIRE);
  });

  it("derives the ratio byte from aligned pours and dose", () => {
    const pours = buildPoursPayload(simpleRecipe());
    assert.equal(pours.payload.at(-1), 0x5e); // 150/16*10 = 93.75 -> 94
  });
});

describe("integer alignment and grinder scale", () => {
  it("uses largest remainders and preserves the requested total", () => {
    const recipe = simpleRecipe({
      grandWater: 150,
      pours: [
        { ...simpleRecipe().pours[0], volume: 35.4 },
        { ...simpleRecipe().pours[1], volume: 114.6 },
      ],
    });
    const aligned = alignBlePourVolumes(recipe);
    assert.deepEqual(aligned, [35, 115]);
    assert.equal(
      aligned.reduce((sum, value) => sum + value, 0),
      150,
    );
  });

  it("maps cloud 40/80/120 to device 1/41/80", () => {
    assert.equal(grinderCloudToBle(40), 1);
    assert.equal(grinderCloudToBle(80), 41);
    assert.equal(grinderCloudToBle(120), 80);
  });
});
