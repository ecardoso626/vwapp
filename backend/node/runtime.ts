import { createServer, type Server } from "node:http";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { CORSPlugin } from "@orpc/server/plugins";
import { authenticateHttpRequest, authHttpError } from "../auth/http";
import type { DeviceAuthService } from "../auth/service";
import type { Db } from "../src/application-store";
import { router } from "../src/router";
import type { NodeAccountApi } from "./account";
import type { NodeConfig } from "./config";
import type { NodeLockCommands } from "./lock-commands";
import type { NodePassiveApi } from "./passive";
import {
  createNodeScheduler,
  type SchedulerClock,
  type SchedulerJobs,
} from "./scheduler";
import { OWNER_ID } from "./sqlite-store";

export interface NodeServices extends SchedulerJobs {
  auth: DeviceAuthService;
  db: Db;
  passive?: NodePassiveApi;
  account?: NodeAccountApi;
  commands?: NodeLockCommands;
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

    let decision: Awaited<ReturnType<typeof authenticateHttpRequest>>;
    try {
      decision = await authenticateHttpRequest(
        request,
        services.auth,
        config.publicOrigin,
      );
    } catch (error) {
      const failure = authHttpError(error);
      response.writeHead(failure.status, {
        "content-type": "application/json",
      });
      response.end(failure.body);
      return;
    }
    if (decision.kind === "paired") {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ device: decision.device }));
      return;
    }
    if (decision.kind !== "authorized") {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    if (request.url?.startsWith("/api/v1/")) {
      const result =
        services.commands?.handle(
          request.method ?? "GET",
          request.url,
          decision.body,
          decision.device,
        ) ??
        (await services.account?.handle(
          request.method ?? "GET",
          request.url,
          decision.body,
          decision.device,
        )) ??
        (await services.passive?.handle(
          request.method ?? "GET",
          request.url,
          decision.body,
          decision.device,
        ));
      response.writeHead(result?.status ?? 404, {
        "content-type": "application/json",
        "cache-control": "private, no-store",
      });
      response.end(JSON.stringify(result?.body ?? { error: "not_found" }));
      return;
    }

    // Retire Node's legacy account mutations: the safe account API owns
    // connection metadata and never exposes raw upstream credential errors.
    if (
      [
        "/rpc/auth/login",
        "/rpc/auth/checkCredentials",
        "/rpc/auth/logout",
        "/rpc/vehicle/command",
        "/rpc/vehicle/chargeStart",
        "/rpc/vehicle/chargeStop",
        "/rpc/vehicle/setChargeLimit",
        "/rpc/vehicle/climateStart",
        "/rpc/vehicle/climateStop",
        "/rpc/vehicle/climateInfo",
        "/rpc/vehicle/refresh",
      ].includes(
        decodeURIComponent((request.url ?? "").split("?")[0] ?? "").replace(
          /\/+$/,
          "",
        ),
      )
    ) {
      response.writeHead(410, {
        "content-type": "application/json",
        "cache-control": "private, no-store",
      });
      response.end('{"error":"account_api_required"}');
      return;
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (
        value === undefined ||
        [
          "authorization",
          "x-instant-token",
          "host",
          "content-length",
          "connection",
          "transfer-encoding",
        ].includes(name)
      )
        continue;
      if (Array.isArray(value))
        value.forEach((item) => {
          headers.append(name, item);
        });
      else headers.set(name, value);
    }
    const rpcRequest = new Request(decision.signedUrl, {
      method: request.method ?? "GET",
      headers,
      ...(decision.body.length === 0
        ? {}
        : { body: new Uint8Array(decision.body) }),
    });
    const { matched, response: rpcResponse } = await handler.handle(
      rpcRequest,
      {
        prefix: "/rpc",
        context: { env: config.env, db: services.db, userId: OWNER_ID },
      },
    );
    if (!matched) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    const outboundHeaders: Record<string, string> = {};
    rpcResponse.headers.forEach((value, name) => {
      outboundHeaders[name] = value;
    });
    response.writeHead(rpcResponse.status, outboundHeaders);
    response.end(Buffer.from(await rpcResponse.arrayBuffer()));
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
        const commandsDone = services.commands?.stop();
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
        await commandsDone;
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
