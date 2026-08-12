import type http from "node:http";
import type { AddressInfo } from "node:net";

// Fetch follows the WHATWG blocked-port list even for loopback fixtures. Windows can
// occasionally allocate one of those ports for listen(0), making an otherwise healthy
// test suite fail before the request reaches Express.
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080,
]);

export async function fetchSafePort(server: http.Server): Promise<number> {
  for (;;) {
    if (!server.listening) {
      server.listen(0, "127.0.0.1");
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
    }
    const port = (server.address() as AddressInfo).port;
    if (!FETCH_BLOCKED_PORTS.has(port)) return port;
    await shutdownHttpServer(server);
  }
}

/**
 * Close a test HTTP server deterministically before another fixture reuses its role.
 * Waiting for the callback avoids retired keep-alive sockets racing the next mock.
 */
export async function shutdownHttpServer(server: http.Server | null | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}
