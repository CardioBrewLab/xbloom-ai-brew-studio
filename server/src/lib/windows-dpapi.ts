import { execFileSync } from "node:child_process";
import path from "node:path";

export interface DpapiEnvelope {
  algorithm: "windows-dpapi";
  ciphertext: string;
}

const DPAPI_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Security",
  "$request=[Console]::In.ReadToEnd() | ConvertFrom-Json",
  "$bytes=[Convert]::FromBase64String([string]$request.data)",
  "$entropy=[Text.Encoding]::UTF8.GetBytes([string]$request.entropy)",
  "if ([string]$request.action -eq 'protect') {$output=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)} elseif ([string]$request.action -eq 'unprotect') {$output=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)} else {throw 'Unsupported DPAPI action'}",
  "[Console]::Out.Write([Convert]::ToBase64String($output))",
].join(";");

function transform(action: "protect" | "unprotect", input: Buffer, entropy: string): Buffer {
  if (process.platform !== "win32") {
    throw new Error("本机敏感数据保存需要 Windows 用户数据保护服务");
  }
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const powershell = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const output = execFileSync(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", DPAPI_SCRIPT],
    {
      input: JSON.stringify({ action, data: input.toString("base64"), entropy }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 32 * 1024,
    },
  ).trim();
  const result = Buffer.from(output, "base64");
  if (result.length === 0) throw new Error("Windows 用户数据保护服务返回空结果");
  return result;
}

/** Protects text for the current Windows account; plaintext travels through stdin only. */
export function protectCurrentUserText(value: string, entropy: string): DpapiEnvelope {
  return {
    algorithm: "windows-dpapi",
    ciphertext: transform("protect", Buffer.from(value, "utf8"), entropy).toString("base64"),
  };
}

export function unprotectCurrentUserText(value: DpapiEnvelope, entropy: string): string {
  if (value.algorithm !== "windows-dpapi" || !value.ciphertext) {
    throw new Error("受保护数据格式不正确");
  }
  return transform("unprotect", Buffer.from(value.ciphertext, "base64"), entropy).toString("utf8");
}
