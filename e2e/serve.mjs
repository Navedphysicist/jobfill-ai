// Tiny static server for e2e/fixtures (keeps the project free of extra dependencies).
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

http.createServer(async (req, res) => {
  const name = path.basename(new URL(req.url, "http://x").pathname) || "form.html";
  try {
    const body = await readFile(path.join(dir, name));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(5577, "127.0.0.1");
