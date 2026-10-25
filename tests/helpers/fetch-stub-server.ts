import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// The Chromium e2e suites' local stub (bm78 gate, bm79 activation): a server
// on 127.0.0.1 that counts every request. The hardened page must block every
// external fetch, so `hits()` stays 0.
export interface FetchStubServer {
  origin: string;
  hits(): number;
  close(): Promise<void>;
}

export async function startFetchStubServer(): Promise<FetchStubServer> {
  let hits = 0;
  const server: Server = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "image/png" });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits: () => hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
