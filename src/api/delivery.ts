import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

// Smaller than this, compressing costs more than it saves.
const MIN_BYTES = 1024;

type Encoding = "br" | "gzip";

function accepted(req: FastifyRequest): Encoding | null {
  const header = String(req.headers["accept-encoding"] ?? "");
  if (/\bbr\b/.test(header)) return "br";
  if (/\bgzip\b/.test(header)) return "gzip";
  return null;
}

const compress = (body: Buffer, enc: Encoding) =>
  enc === "br" ? brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }) : gzipSync(body);

// The app shell, read and compressed once. The browser keeps a copy and asks
// again each time (ETag), so a release reaches everyone on the next load.
export async function serveAssets(app: FastifyInstance, dir: string, assets: Record<string, string>) {
  const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
  for (const [route, file] of Object.entries(assets)) {
    const body = await readFile(path.join(dir, file));
    const etag = `"${createHash("sha1").update(body).digest("base64url").slice(0, 16)}"`;
    const packed = { br: compress(body, "br"), gzip: compress(body, "gzip") };
    app.get(route, async (req, reply) => {
      reply.type(types[path.extname(file)]).header("Cache-Control", "no-cache").header("ETag", etag).header("Vary", "Accept-Encoding");
      if (req.headers["if-none-match"] === etag) return reply.status(304).send();
      const enc = accepted(req);
      if (!enc) return reply.send(body);
      return reply.header("Content-Encoding", enc).send(packed[enc]);
    });
  }
}

// Compresses large JSON answers (lists, the work center) for browsers that accept it.
export function compressJson(app: FastifyInstance) {
  app.addHook("onSend", async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    if (typeof payload !== "string" || payload.length < MIN_BYTES) return payload;
    if (!String(reply.getHeader("content-type") ?? "").startsWith("application/json")) return payload;
    const enc = accepted(req);
    if (!enc || reply.getHeader("content-encoding")) return payload;
    reply.header("Content-Encoding", enc).header("Vary", "Accept-Encoding").removeHeader("content-length");
    return compress(Buffer.from(payload), enc);
  });
}
