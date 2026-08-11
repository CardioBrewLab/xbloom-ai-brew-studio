import { Router, type Request } from "express";
import { researchBean, type BeanResearchInput } from "../lib/research.js";
import {
  issueCompanionPairing,
  localWorkbenchOrigin,
  pairingPage,
  revokeCompanionPairing,
  trustedWebOrigin,
  type CompanionAccessOptions,
} from "../lib/companion-access.js";

function localRequestOrigin(req: Request): string {
  return `${req.protocol}://${req.get("host") ?? ""}`;
}

export function createCompanionRouter(options: CompanionAccessOptions = {}): Router {
  const router = Router();
  const pairingFile = options.pairingFile;
  const now = options.now ?? Date.now;

  router.get("/pair", (req, res) => {
    try {
      const origin = typeof req.query.origin === "string" ? req.query.origin : "";
      res
        .status(200)
        .set({
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        })
        .send(pairingPage(origin));
    } catch (error) {
      res
        .status(400)
        .type("text/plain")
        .send((error as Error).message);
    }
  });

  router.post("/pair", (req, res) => {
    try {
      const requestOrigin = localRequestOrigin(req);
      if (!localWorkbenchOrigin(requestOrigin) || req.get("origin") !== requestOrigin) {
        res.status(403).json({ ok: false, message: "请在本机配对窗口中确认连接" });
        return;
      }
      const targetOrigin = req.body && typeof req.body.origin === "string" ? req.body.origin : "";
      if (!trustedWebOrigin(targetOrigin)) {
        res.status(400).json({ ok: false, message: "配对目标地址格式有误" });
        return;
      }
      const pairing = issueCompanionPairing(targetOrigin, pairingFile, now());
      res.set("cache-control", "no-store").json({ ok: true, ...pairing });
    } catch (error) {
      res.status(500).json({ ok: false, message: (error as Error).message || "本机配对未完成" });
    }
  });

  router.delete("/pair", (req, res) => {
    const origin = req.get("origin") ?? "";
    revokeCompanionPairing(origin, pairingFile);
    res.set("cache-control", "no-store").json({ ok: true });
  });

  router.get("/status", (_req, res) => {
    res.json({ ok: true, connected: true, capabilities: { research: true, xhs: true } });
  });

  router.post("/research", async (req, res) => {
    const source = req.body && typeof req.body === "object" ? req.body : {};
    const text = (value: unknown, max: number): string | undefined =>
      typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
    const input: BeanResearchInput = {
      name: text(source.name, 160),
      roaster: text(source.roaster, 160),
      origin: text(source.origin, 160),
      process: text(source.process, 160),
      varietal: text(source.varietal, 160),
      roastLevel: text(source.roastLevel, 80),
      tastingNotes: text(source.tastingNotes, 500),
      freeText: text(source.freeText, 4_000),
    };
    try {
      const result = await researchBean(input, undefined, AbortSignal.timeout(45_000));
      res.json({ ok: true, research: result });
    } catch (error) {
      res.json({ ok: false, message: (error as Error).message || "本地调研未完成" });
    }
  });

  return router;
}

export default createCompanionRouter();
