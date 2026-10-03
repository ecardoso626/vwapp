import { createServer, type Server } from "node:http";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/node";
import { CORSPlugin } from "@orpc/server/plugins";
import { router } from "../src/router";
import type { Db } from "../src/store";
import type { NodeConfig } from "./config";
import {
  createNodeScheduler,
  type SchedulerClock,
  type SchedulerJobs,
} from "./scheduler";

export interface NodeServices extends SchedulerJobs {
  db: Db;
}

export function createNodeRuntime(
  config: NodeConfig,
  services: NodeServices,
  options: { clock?: SchedulerClock; intervalMs?: number } = {},
) {
  const handler = new RPCHandler(router, {
    plugins: [new CORSPlugin()],
    interceptors: [
      onError((error) => {
        console.error(
          "[node] RPC error",
          error instanceof Error ? error.name : "unknown",
        );
      }),
    ],
  });
  const scheduler = createNodeScheduler(services, options);
  const handleRequest = async (
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ): Promise<void> => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"ok"}');
      return;
    }

    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : null;
    let userId: string | null = null;
    if (token !== null && token !== "") {
      try {
        userId = (await services.db.auth.verifyToken(token)).id;
      } catch {
        userId = null;
      }
    }

    const { matched } = await handler.handle(request, response, {
      prefix: "/rpc",
      context: { env: config.env, db: services.db, userId },
    });
    if (!matched) {
      response.writeHead(404);
      response.end("Not found");
    }
  };
  const server: Server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      console.error(
        "[node] HTTP adapter failed",
        error instanceof Error ? error.name : "unknown",
      );
      if (!response.headersSent) response.writeHead(500);
      response.end("Internal server error");
    });
  });
  let listening = false;
  let stopping: Promise<void> | null = null;

  return {
    async start(): Promise<{ host: string; port: number }> {
      if (listening || stopping !== null)
        throw new Error("Node runtime already started");
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      listening = true;
      if (config.schedulerEnabled) scheduler.start();
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("Node server has no TCP address");
      return { host: config.host, port: address.port };
    },
    stop(): Promise<void> {
      if (stopping !== null) return stopping;
      stopping = (async () => {
        const jobsDone = scheduler.stop();
        if (listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) reject(error);
              else resolve();
            });
          });
          listening = false;
        }
        await jobsDone;
      })();
      return stopping;
    },
  };
}

/** Register only after startup; a second signal shares the same shutdown. */
export function installShutdownSignals(
  stop: () => Promise<void>,
  signalSource: Pick<NodeJS.Process, "once" | "off"> = process,
  onExitCode: (code: number) => void = (code) => {
    process.exitCode = code;
  },
): () => void {
  const shutdown = () => {
    void stop().then(
      () => {
        onExitCode(0);
      },
      (error: unknown) => {
        console.error("[node] shutdown failed", error);
        onExitCode(1);
      },
    );
  };
  signalSource.once("SIGTERM", shutdown);
  signalSource.once("SIGINT", shutdown);
  return () => {
    signalSource.off("SIGTERM", shutdown);
    signalSource.off("SIGINT", shutdown);
  };
}
