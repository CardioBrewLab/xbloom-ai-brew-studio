import type http from "node:http";

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
