import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import * as schema from "./schema";

export type DatabaseSettings = {
  connectionString: string;
  /**
   * host:port/path of a Neon wsproxy in front of a plain Postgres (local
   * development and CI). Unset against Neon, which speaks WebSockets itself.
   */
  wsProxy?: string;
};

/**
 * Opens a Drizzle database over Neon's WebSocket `Pool` driver (D-07). The
 * WebSocket driver, unlike the HTTP one, supports interactive transactions,
 * so `set_config(..., true)` and SAVEPOINTs work.
 */
export function createDatabase({ connectionString, wsProxy }: DatabaseSettings) {
  // Node has no WebSocket the driver can rely on across versions; use `ws`.
  neonConfig.webSocketConstructor = ws;
  if (wsProxy) {
    // A local proxy speaks plain ws:// and the Postgres behind it uses SCRAM,
    // so turn off TLS and the cleartext-password pipelining Neon allows.
    neonConfig.wsProxy = () => wsProxy;
    neonConfig.useSecureWebSocket = false;
    neonConfig.pipelineTLS = false;
    neonConfig.pipelineConnect = false;
  }

  const pool = new Pool({ connectionString });
  // A connection that drops while idle in the pool is emitted here, outside any
  // request, and an unhandled `error` event would take the process down. The
  // pool replaces the connection, so noting it is enough. Only the code: the
  // error object holds the client, and the client holds the password.
  pool.on("error", (error: Error & { code?: string }) => {
    console.error(`Idle database connection lost: ${error.code ?? error.name}`);
  });
  const db = drizzle({ client: pool, schema });
  return { db, pool };
}

export type Database = ReturnType<typeof createDatabase>["db"];
