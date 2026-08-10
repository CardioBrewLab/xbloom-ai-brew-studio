"""One-shot native BLE helper for Windows/macOS/Linux.

JSON is read from stdin and one JSON object is written to stdout.  Hardware
addresses never leave this process.  The helper uses the OS Bluetooth stack via
Bleak and the hardware-verified xbloom-ble protocol package.
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

SERVICE_UUID = "0000e0ff-3c17-d293-8e48-14fe2e4da212"


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


async def discover(timeout: float):
    from bleak import BleakScanner

    advertisements = await BleakScanner.discover(timeout=timeout, return_adv=True)
    matches = []
    for _address, (device, advertisement) in advertisements.items():
        name = (advertisement.local_name or getattr(device, "name", None) or "").strip()
        services = {str(item).lower() for item in (advertisement.service_uuids or [])}
        if SERVICE_UUID in services or name.upper().startswith("XBLOOM"):
            matches.append((device, name or "xBloom Studio", int(advertisement.rssi)))
    matches.sort(key=lambda item: item[2], reverse=True)
    return matches, len(advertisements)


async def run(request: dict[str, Any]) -> dict[str, Any]:
    command = request.get("command")
    timeout = min(30.0, max(3.0, float(request.get("timeout", 12.0))))

    if command == "probe":
        import bleak  # noqa: F401
        import xbloom_ble  # noqa: F401

        return {"ok": True, "backend": "python-bleak"}

    matches, discovered_count = await discover(timeout)
    if not matches:
        return {
            "ok": False,
            "failureKind": "device_not_found",
            "discoveredCount": discovered_count,
            "message": (
                f"系统蓝牙扫描到 {discovered_count} 台 BLE 设备，但没有处于可连接状态的 xBloom。"
                "请让机器保持唤醒，并暂时断开手机 xBloom App 的蓝牙连接后重试。"
            ),
        }

    device, name, rssi = matches[0]
    if command == "scan":
        return {
            "ok": True,
            "found": True,
            "device": name,
            "rssi": rssi,
            "discoveredCount": discovered_count,
        }

    from xbloom_ble import Recipe
    from xbloom_ble.client import XBloomClient

    if command == "load":
        raw_recipe = request.get("recipe")
        if not isinstance(raw_recipe, dict):
            return {"ok": False, "failureKind": "invalid_recipe", "message": "缺少 BLE 配方"}
        recipe = Recipe.from_dict(raw_recipe)
        async with XBloomClient(device.address) as client:
            await client.load_recipe(recipe)
        return {
            "ok": True,
            "loaded": True,
            "device": name,
            "requiresMachineConfirmation": True,
            "message": "配方已加载到机器，请在机器上确认开始。",
        }

    if command == "cancel":
        async with XBloomClient(device.address) as client:
            await client.cancel_brew()
        return {"ok": True, "device": name, "message": "已发送停止指令"}

    return {"ok": False, "failureKind": "invalid_command", "message": "未知 BLE helper 命令"}


def main() -> int:
    try:
        raw = sys.stdin.read(1_000_001)
        if len(raw) > 1_000_000:
            raise ValueError("请求体过大")
        request = json.loads(raw or "{}")
        if not isinstance(request, dict):
            raise ValueError("请求必须是 JSON 对象")
        emit(asyncio.run(run(request)))
        return 0
    except Exception as exc:  # structured boundary for the Node bridge
        emit({"ok": False, "failureKind": "backend_error", "message": str(exc)[:500]})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
