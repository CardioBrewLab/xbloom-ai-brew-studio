function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function bigIntToBytes(value: bigint, length: number): Uint8Array {
  const output = new Uint8Array(length);
  let remaining = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining !== 0n) throw new Error("RSA 密文超出模数长度");
  return output;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let factor = base % modulus;
  let power = exponent;
  while (power > 0n) {
    if (power & 1n) result = (result * factor) % modulus;
    power >>= 1n;
    factor = (factor * factor) % modulus;
  }
  return result;
}

function nonZeroRandom(length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const candidate = new Uint8Array(length - offset);
    crypto.getRandomValues(candidate);
    for (const byte of candidate) {
      if (byte === 0) continue;
      result[offset] = byte;
      offset += 1;
      if (offset >= length) break;
    }
  }
  return result;
}

/** 通用 RSAES-PKCS1-v1_5 公钥加密；xBloom 协议要求该旧版填充。 */
export function rsaPkcs1EncryptChunk(
  message: Uint8Array,
  modulus: bigint,
  exponent: bigint,
  modulusBytes: number,
): Uint8Array {
  if (message.length > modulusBytes - 11) throw new Error("RSA 明文块过长");
  const padding = nonZeroRandom(modulusBytes - message.length - 3);
  const encoded = new Uint8Array(modulusBytes);
  encoded[0] = 0;
  encoded[1] = 2;
  encoded.set(padding, 2);
  encoded[2 + padding.length] = 0;
  encoded.set(message, 3 + padding.length);
  return bigIntToBytes(modPow(bytesToBigInt(encoded), exponent, modulus), modulusBytes);
}

interface Tlv {
  tag: number;
  value: Uint8Array;
  next: number;
}

function readTlv(data: Uint8Array, offset: number): Tlv {
  const tag = data[offset];
  let cursor = offset + 1;
  let length = data[cursor++];
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let index = 0; index < count; index += 1) length = length * 256 + data[cursor++];
  }
  const end = cursor + length;
  if (end > data.length) throw new Error("RSA 公钥 DER 长度有误");
  return { tag, value: data.slice(cursor, end), next: end };
}

/** 解析 SubjectPublicKeyInfo DER 里的 RSA modulus / exponent。 */
export function parseSpkiRsaPublicKey(base64Der: string): {
  modulus: bigint;
  exponent: bigint;
  modulusBytes: number;
} {
  const outer = readTlv(base64ToBytes(base64Der), 0);
  if (outer.tag !== 0x30) throw new Error("RSA 公钥缺少外层 SEQUENCE");
  const algorithm = readTlv(outer.value, 0);
  const bitString = readTlv(outer.value, algorithm.next);
  if (bitString.tag !== 0x03 || bitString.value[0] !== 0)
    throw new Error("RSA 公钥 BIT STRING 有误");
  const rsaSequence = readTlv(bitString.value.slice(1), 0);
  const modulusTlv = readTlv(rsaSequence.value, 0);
  const exponentTlv = readTlv(rsaSequence.value, modulusTlv.next);
  if (modulusTlv.tag !== 0x02 || exponentTlv.tag !== 0x02) throw new Error("RSA 公钥整数缺失");
  const modulusBytes = modulusTlv.value[0] === 0 ? modulusTlv.value.slice(1) : modulusTlv.value;
  return {
    modulus: bytesToBigInt(modulusBytes),
    exponent: bytesToBigInt(exponentTlv.value),
    modulusBytes: modulusBytes.length,
  };
}

export function rsaPkcs1Encrypt(
  plaintext: Uint8Array,
  publicKey: { modulus: bigint; exponent: bigint; modulusBytes: number },
): Uint8Array {
  const maxChunk = publicKey.modulusBytes - 11;
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < plaintext.length; offset += maxChunk) {
    chunks.push(
      rsaPkcs1EncryptChunk(
        plaintext.slice(offset, offset + maxChunk),
        publicKey.modulus,
        publicKey.exponent,
        publicKey.modulusBytes,
      ),
    );
  }
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let cursor = 0;
  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.length;
  }
  return output;
}
