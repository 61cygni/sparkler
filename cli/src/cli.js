/**
 * Sparkler CLI — convert, login (Clerk → Convex JWT), host (Convex + Tigris), list, del, embed-snippet.
 */
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { ConvexHttpClient } from "convex/browser";
import { config as loadDotenv } from "dotenv";
import { api } from "../../convex/_generated/api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function sparklerRoot() {
  return path.resolve(__dirname, "..", "..");
}

function loadCliEnv() {
  const explicit = process.env.SPARKLER_ENV_FILE;
  const candidates = explicit
    ? [path.resolve(explicit)]
    : [
        path.resolve(process.cwd(), ".env"),
        path.resolve(process.cwd(), ".env.local"),
      ];

  for (const envPath of candidates) {
    if (!existsSync(envPath)) {
      continue;
    }
    loadDotenv({
      path: envPath,
      override: false,
      quiet: true,
    });
  }
}

function loadConfig() {
  const fromEnv = process.env.SPARKLER_CONFIG;
  const p = fromEnv ?? path.join(homedir(), ".config", "sparkler", "config.json");
  if (!existsSync(p)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function resolveSparkRoot() {
  const env = process.env.SPARKLER_SPARK_ROOT;
  if (env && existsSync(path.join(env, "package.json"))) {
    const pkg = JSON.parse(readFileSync(path.join(env, "package.json"), "utf8"));
    if (pkg.scripts?.["build-lod"]) return path.resolve(env);
  }
  const sibling = path.resolve(sparklerRoot(), "..", "spark");
  if (existsSync(path.join(sibling, "package.json"))) {
    const pkg = JSON.parse(readFileSync(path.join(sibling, "package.json"), "utf8"));
    if (pkg.scripts?.["build-lod"]) return sibling;
  }
  throw new Error(
    "Could not find Spark checkout with npm run build-lod. Set SPARKLER_SPARK_ROOT to the spark repo root.",
  );
}

/** build-lod writes `<stem>-lod.rad` next to the input file. */
function defaultRadPath(inputAbs) {
  const { dir, name } = path.parse(inputAbs);
  return path.join(dir, `${name}-lod.rad`);
}

const MIME = {
  ".rad": "application/octet-stream",
  ".spz": "application/octet-stream",
  ".ply": "application/octet-stream",
  ".splat": "application/octet-stream",
  ".ksplat": "application/octet-stream",
};

function guessContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

function parseConvertArgv(argv) {
  let output = null;
  const positional = [];
  let passthrough = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--") {
      passthrough = argv.slice(i + 1);
      break;
    }
    if (a === "-o" || a === "--output") {
      output = argv[i + 1];
      if (!output) throw new Error(`${a} requires a path`);
      i += 2;
      continue;
    }
    if (a.startsWith("-")) {
      throw new Error(`Unknown option: ${a}`);
    }
    positional.push(a);
    i += 1;
  }
  if (positional.length === 0) {
    throw new Error("Provide at least one input file (e.g. scan.spz)");
  }
  return { positional, output, passthrough };
}

function cmdConvert(argv) {
  const { positional, output, passthrough } = parseConvertArgv(argv);
  const sparkRoot = resolveSparkRoot();
  for (const input of positional) {
    const abs = path.resolve(input);
    if (!existsSync(abs)) {
      console.error(`Not found: ${abs}`);
      process.exit(1);
    }
    const r = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["run", "build-lod", "--", abs, ...passthrough],
      { cwd: sparkRoot, stdio: "inherit", shell: false },
    );
    if (r.status !== 0) {
      process.exit(r.status ?? 1);
    }
    const produced = defaultRadPath(abs);
    if (!existsSync(produced)) {
      console.error(`Expected output missing: ${produced}`);
      process.exit(1);
    }
    if (output) {
      if (positional.length > 1) {
        console.warn("Ignoring -o when multiple inputs were converted (each has its own -lod.rad).");
      } else {
        const outAbs = path.resolve(output);
        renameSync(produced, outAbs);
        console.log(outAbs);
        return;
      }
    }
    console.log(produced);
  }
}

function convexSiteUrl(config) {
  return (
    process.env.SPARKLER_CONVEX_SITE_URL?.replace(/\/$/, "") ||
    config.convexSiteUrl?.replace(/\/$/, "") ||
    inferSiteFromConvexUrl(process.env.VITE_CONVEX_URL) ||
    inferSiteFromConvexUrl(process.env.SPARKLER_CONVEX_URL) ||
    inferSiteFromConvexUrl(config.convexUrl)
  );
}

function inferSiteFromConvexUrl(url) {
  if (!url || typeof url !== "string") return null;
  const u = url.replace(/\/$/, "");
  if (u.includes(".convex.cloud")) {
    return u.replace(".convex.cloud", ".convex.site");
  }
  return null;
}

/** Convex backend URL (.convex.cloud) for ConvexHttpClient. */
function convexCloudUrl(config) {
  return (
    process.env.SPARKLER_CONVEX_URL?.replace(/\/$/, "") ||
    process.env.VITE_CONVEX_URL?.replace(/\/$/, "") ||
    config.convexUrl?.replace(/\/$/, "") ||
    null
  );
}

function deploymentUrl(config) {
  return (
    process.env.SPARKLER_DEPLOYMENT_URL?.replace(/\/$/, "") ||
    config.deploymentUrl?.replace(/\/$/, "") ||
    null
  );
}

function credentialsPath() {
  return path.join(homedir(), ".config", "sparkler", "credentials.json");
}

function loadCredentials() {
  const p = credentialsPath();
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (j.accessToken && j.convexUrl) return j;
  } catch {
    /* ignore */
  }
  return null;
}

function saveCredentials(obj) {
  const p = credentialsPath();
  const dir = path.dirname(p);
  mkdirSync(dir, { recursive: true });
  writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

function cliToken() {
  return process.env.SPARKLER_CLI_TOKEN || process.env.SPARKLER_API_TOKEN || null;
}

function boolish(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function demoMode(config, opts = {}) {
  return Boolean(opts.demo) || boolish(process.env.SPARKLER_DEMO) || config.demoMode === true;
}

function deployForViewerLinks(config) {
  return loadCredentials()?.deploymentUrl || deploymentUrl(config);
}

function openBrowser(url) {
  const { platform } = process;
  if (platform === "darwin") {
    spawnSync("open", [url], { stdio: "ignore" });
  } else if (platform === "win32") {
    spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
  } else {
    spawnSync("xdg-open", [url], { stdio: "ignore" });
  }
}

function viewerUrlFor(deploy, sceneId) {
  return `${deploy}/s/${sceneId}`;
}

function embedUrlFor(deploy, sceneId) {
  return `${deploy}/embed/${sceneId}`;
}

function logPhase(opts, message) {
  if (process.stderr.isTTY && !opts.json) {
    console.error(message);
  }
}

function formatCreatedAt(ts) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
  return new Date(ts).toISOString().replace(".000Z", "Z");
}

function enrichScene(scene, deploy) {
  return {
    sceneId: scene._id,
    title: scene.title,
    visibility: scene.visibility,
    status: scene.status,
    createdAt: scene.createdAt,
    created: formatCreatedAt(scene.createdAt),
    viewerUrl: viewerUrlFor(deploy, scene._id),
    embedUrl: embedUrlFor(deploy, scene._id),
    filename: scene.filename,
    byteSize: scene.byteSize ?? null,
  };
}

function parseViewPayload(opts) {
  const fromJson = opts.viewJson;
  const fromFile = opts.viewFile;
  if ((fromJson ? 1 : 0) + (fromFile ? 1 : 0) !== 1) {
    console.error("Provide exactly one of --view-json or --view-file.");
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(fromJson ?? readFileSync(path.resolve(fromFile), "utf8"));
  } catch (e) {
    console.error("Invalid view JSON:", e?.message ?? String(e));
    process.exit(1);
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray(parsed.position) ||
    !Array.isArray(parsed.target) ||
    parsed.position.length < 3 ||
    parsed.target.length < 3
  ) {
    console.error("View JSON must include position and target arrays with at least 3 numbers.");
    process.exit(1);
  }

  return {
    position: parsed.position.slice(0, 3).map(Number),
    target: parsed.target.slice(0, 3).map(Number),
    quaternion: Array.isArray(parsed.quaternion)
      ? parsed.quaternion.slice(0, 4).map(Number)
      : undefined,
  };
}

async function promptYesNo(question) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(question);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

const RECEIVE_PAGE = `<!DOCTYPE html>
<meta charset="utf-8">
<title>Sparkler CLI</title>
<body>
<p id="m">Finishing login…</p>
<script>
(async () => {
  const m = document.getElementById("m");
  const raw = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  const p = new URLSearchParams(raw);
  const t = p.get("t");
  if (!t) { m.textContent = "Missing token in URL hash."; return; }
  try {
    const r = await fetch("/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken: t }),
    });
    if (!r.ok) throw new Error(await r.text());
    m.textContent = "Saved. You can close this tab.";
  } catch (e) {
    m.textContent = "Error: " + e;
  }
})();
</script>
`;

function waitForCliToken(port, onListening) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = createServer((req, res) => {
      const u = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      if (req.method === "GET" && u.pathname === "/receive") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(RECEIVE_PAGE);
        return;
      }
      if (req.method === "POST" && u.pathname === "/token") {
        let body = "";
        req.on("data", (c) => {
          body += c;
        });
        req.on("end", () => {
          if (settled) {
            res.writeHead(409);
            res.end("Already completed");
            return;
          }
          try {
            const j = JSON.parse(body);
            if (!j.accessToken || typeof j.accessToken !== "string") {
              res.writeHead(400);
              res.end("Expected JSON { accessToken }");
              return;
            }
            settled = true;
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("OK");
            server.close(() => resolve({ accessToken: j.accessToken }));
          } catch (e) {
            res.writeHead(400);
            res.end(String(e?.message || e));
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      try {
        onListening?.();
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

async function cmdLogin(opts) {
  const config = loadConfig();
  const port = Number.parseInt(String(opts.port ?? "9876"), 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    console.error("Invalid --port");
    process.exit(1);
  }
  const convexUrl = convexCloudUrl(config);
  const deploy = deploymentUrl(config);
  if (!convexUrl) {
    console.error(
      "Set SPARKLER_CONVEX_URL (https://….convex.cloud) or convexUrl in ~/.config/sparkler/config.json.",
    );
    process.exit(1);
  }
  if (!deploy) {
    console.error(
      "Set SPARKLER_DEPLOYMENT_URL (origin where the Sparkler app is hosted) or deploymentUrl in config.",
    );
    process.exit(1);
  }

  const loginUrl = `${deploy}/cli-login?port=${port}`;
  console.log(`If the browser does not open, visit:\n  ${loginUrl}`);
  console.log(`After signing in, click “Send token to CLI”.`);
  console.log(`Listening on http://127.0.0.1:${port} …`);

  const { accessToken } = await waitForCliToken(port, () => openBrowser(loginUrl));
  saveCredentials({
    accessToken,
    convexUrl,
    deploymentUrl: deploy,
  });
  console.log(`Stored Clerk → Convex token in ${credentialsPath()}`);
}

function prepareHostFile(absPath, opts) {
  const ext = path.extname(absPath).toLowerCase();
  if (opts.noConvert || ext === ".rad") {
    return {
      uploadPath: absPath,
      displayBasename: path.basename(absPath),
      cleanup: () => {},
    };
  }

  const tmpRoot = mkdtempSync(path.join(tmpdir(), "sparkler-host-"));
  const cleanup = () => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  try {
    const base = path.basename(absPath);
    const tmpInput = path.join(tmpRoot, base);
    copyFileSync(absPath, tmpInput);
    const sparkRoot = resolveSparkRoot();
    const extra = opts.quick ? [] : ["--quality"];
    const r = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["run", "build-lod", "--", tmpInput, ...extra],
      { cwd: sparkRoot, stdio: "inherit", shell: false },
    );
    if (r.status !== 0) {
      cleanup();
      process.exit(r.status ?? 1);
    }
    const rad = defaultRadPath(tmpInput);
    if (!existsSync(rad)) {
      console.error(`Expected output missing: ${rad}`);
      cleanup();
      process.exit(1);
    }
    const stem = path.parse(base).name;
    return {
      uploadPath: rad,
      displayBasename: `${stem}-lod.rad`,
      cleanup,
    };
  } catch (e) {
    cleanup();
    throw e;
  }
}

function resolveHostAuth(config, opts = {}) {
  const cUrl = convexCloudUrl(config);
  const deploy = deploymentUrl(config);
  if (demoMode(config, opts)) {
    if (!cUrl || !deploy) {
      console.error(
        "Demo mode needs SPARKLER_CONVEX_URL and SPARKLER_DEPLOYMENT_URL (or convexUrl/deploymentUrl in config).",
      );
      process.exit(1);
    }
    return { kind: "demo", client: new ConvexHttpClient(cUrl), deploy };
  }

  const creds = loadCredentials();
  const authConvexUrl = creds?.convexUrl || cUrl;
  const authDeploy = creds?.deploymentUrl || deploy;
  if (creds?.accessToken && authConvexUrl) {
    if (!authDeploy) {
      console.error(
        "Missing deployment URL for viewer links. Re-run sparkler login or set SPARKLER_DEPLOYMENT_URL.",
      );
      process.exit(1);
    }
    const client = new ConvexHttpClient(authConvexUrl);
    client.setAuth(creds.accessToken);
    return { kind: "clerk", client, deploy: authDeploy };
  }

  const siteUrl = convexSiteUrl(config);
  const token = cliToken();
  if (!siteUrl || !token || !deploy) {
    console.error(
      "Authenticate with Clerk: run sparkler login (needs SPARKLER_CONVEX_URL + SPARKLER_DEPLOYMENT_URL),\n" +
        "or enable demo mode (--demo or SPARKLER_DEMO=1) with SPARKLER_DEMO_OWNER_SUBJECT in Convex,\n" +
        "or use the HTTP CLI path: set SPARKLER_CLI_TOKEN, SPARKLER_CONVEX_SITE_URL, and SPARKLER_DEPLOYMENT_URL.",
    );
    process.exit(1);
  }
  return { kind: "http", siteUrl, token, deploy };
}

function requireClerkClient(config, opts = {}) {
  const cUrl = convexCloudUrl(config);
  if (demoMode(config, opts)) {
    if (!cUrl) {
      console.error(
        "Demo mode needs SPARKLER_CONVEX_URL (or convexUrl in config) to reach Convex.",
      );
      process.exit(1);
    }
    return new ConvexHttpClient(cUrl);
  }
  const creds = loadCredentials();
  const authConvexUrl = creds?.convexUrl || cUrl;
  if (!creds?.accessToken || !authConvexUrl) {
    return null;
  }
  const client = new ConvexHttpClient(authConvexUrl);
  client.setAuth(creds.accessToken);
  return client;
}

function requireDeleteAuth(config, opts = {}) {
  const client = requireClerkClient(config, opts);
  if (client) {
    return { kind: demoMode(config, opts) ? "demo" : "clerk", client };
  }
  const siteUrl = convexSiteUrl(config);
  const token = cliToken();
  if (!siteUrl || !token) {
    console.error(
      "Run sparkler login, enable demo mode (--demo or SPARKLER_DEMO=1), or set SPARKLER_CLI_TOKEN and SPARKLER_CONVEX_SITE_URL for the HTTP CLI path.",
    );
    process.exit(1);
  }
  return { kind: "http", siteUrl, token };
}

function printHostResult(sceneId, deploy, basename, visibility, storageKey, byteSize, title, opts) {
  const viewerUrl = viewerUrlFor(deploy, sceneId);
  const embedUrl = embedUrlFor(deploy, sceneId);
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          sceneId,
          viewerUrl,
          embedUrl,
          title: title || basename,
          visibility,
          storageKey: storageKey ?? null,
          byteSize,
        },
        null,
        2,
      ),
    );
  } else if (opts.verbose) {
    console.log("Viewer:", viewerUrl);
    console.log("Embed: ", embedUrl);
  } else {
    console.log(viewerUrl);
  }
  if (opts.open) {
    openBrowser(viewerUrl);
  }
}

async function hostWithClerk(client, deploy, uploadPath, basename, st, contentType, visibility, opts) {
  const { sceneId, storageKey } = await client.mutation(api.scenes.createScene, {
    filename: basename,
    title: opts.title || basename,
    visibility,
    contentType,
    byteSize: st.size,
  });

  const { url: uploadUrl, headers: putHeaders } = await client.action(api.tigris.presignUpload, {
    sceneId,
    contentType,
    byteSize: st.size,
  });

  logPhase(opts, "Uploading…");
  const putRes = await putFileStream(uploadUrl, putHeaders, uploadPath);
  if (!putRes.ok) {
    console.error("PUT to storage failed:", putRes.status, await putRes.text());
    await client.mutation(api.scenes.markSceneFailed, { sceneId }).catch(() => {});
    process.exit(1);
  }

  await client.mutation(api.scenes.finalizeScene, {
    sceneId,
    byteSize: st.size,
    contentType,
  });

  logPhase(opts, "Done.");
  printHostResult(
    sceneId,
    deploy,
    basename,
    visibility,
    storageKey,
    st.size,
    opts.title || basename,
    opts,
  );
}

async function hostWithHttp(siteUrl, token, deploy, uploadPath, basename, st, contentType, visibility, opts) {
  const sessionRes = await fetch(`${siteUrl}/cli/upload-session`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filename: basename,
      title: opts.title || basename,
      visibility,
      contentType,
      byteSize: st.size,
    }),
  });

  const sessionText = await sessionRes.text();
  let sessionJson;
  try {
    sessionJson = JSON.parse(sessionText);
  } catch {
    sessionJson = { error: sessionText };
  }

  if (!sessionRes.ok) {
    console.error("upload-session failed:", sessionJson.error ?? sessionText);
    process.exit(1);
  }

  const { sceneId, uploadUrl, headers: putHeaders } = sessionJson;

  logPhase(opts, "Uploading…");
  const putRes = await putFileStream(uploadUrl, putHeaders, uploadPath);
  if (!putRes.ok) {
    console.error("PUT to storage failed:", putRes.status, await putRes.text());
    await fetch(`${siteUrl}/cli/mark-failed`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sceneId }),
    }).catch(() => {});
    process.exit(1);
  }

  const finRes = await fetch(`${siteUrl}/cli/finalize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sceneId,
      byteSize: st.size,
      contentType,
    }),
  });
  const finText = await finRes.text();
  if (!finRes.ok) {
    let errMsg;
    try {
      errMsg = JSON.parse(finText).error;
    } catch {
      errMsg = finText;
    }
    console.error("finalize failed:", errMsg);
    process.exit(1);
  }

  logPhase(opts, "Done.");
  printHostResult(
    sceneId,
    deploy,
    basename,
    visibility,
    sessionJson.storageKey,
    st.size,
    opts.title || basename,
    opts,
  );
}

async function cmdHost(filePath, opts) {
  const config = loadConfig();
  const abs = path.resolve(filePath);
  if (!existsSync(abs)) {
    console.error(`Not found: ${abs}`);
    process.exit(1);
  }

  if (!opts.noConvert && path.extname(abs).toLowerCase() !== ".rad") {
    logPhase(opts, "Converting…");
  }

  const { uploadPath, displayBasename, cleanup } = prepareHostFile(abs, opts);
  try {
    const st = statSync(uploadPath);
    const contentType = opts.contentType || guessContentType(displayBasename);
    const visibility = ["public", "unlisted", "private"].includes(opts.visibility)
      ? opts.visibility
      : "unlisted";

    const auth = resolveHostAuth(config, opts);
    if (auth.kind === "clerk" || auth.kind === "demo") {
      await hostWithClerk(
        auth.client,
        auth.deploy,
        uploadPath,
        displayBasename,
        st,
        contentType,
        visibility,
        opts,
      );
    } else {
      await hostWithHttp(
        auth.siteUrl,
        auth.token,
        auth.deploy,
        uploadPath,
        displayBasename,
        st,
        contentType,
        visibility,
        opts,
      );
    }
  } finally {
    cleanup();
  }
}

async function putFileStream(url, headers, filePath) {
  const h = new Headers(headers);
  const size = statSync(filePath).size;
  h.set("Content-Length", String(size));
  const stream = createReadStream(filePath);
  try {
    return await fetch(url, {
      method: "PUT",
      headers: h,
      duplex: "half",
      body: stream,
    });
  } catch (e) {
    if (String(e).includes("duplex")) {
      const buf = readFileSync(filePath);
      return fetch(url, { method: "PUT", headers: h, body: buf });
    }
    throw e;
  }
}

async function fetchJsonOrExit(url, init, label) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg = json?.error ?? text ?? `${label} failed`;
    console.error(`${label} failed:`, msg);
    process.exit(1);
  }
  return json;
}

async function cmdList(opts) {
  const config = loadConfig();
  const limit = Math.min(Number.parseInt(String(opts.limit ?? "100"), 10) || 100, 200);
  const deploy = deployForViewerLinks(config);
  if (!deploy) {
    console.error(
      "Set SPARKLER_DEPLOYMENT_URL, enable demo mode, run sparkler login, or add deploymentUrl to config for viewer links.",
    );
    process.exit(1);
  }

  const client = requireClerkClient(config, opts);
  let rows;
  if (client) {
    rows = await client.query(api.scenes.listMyScenes, { limit });
  } else {
    const siteUrl = convexSiteUrl(config);
    const token = cliToken();
    if (!siteUrl || !token) {
      console.error(
        "Run sparkler login, enable demo mode (--demo or SPARKLER_DEMO=1), or set SPARKLER_CLI_TOKEN and SPARKLER_CONVEX_SITE_URL for the HTTP CLI path.",
      );
      process.exit(1);
    }
    rows = await fetchJsonOrExit(
      `${siteUrl}/cli/scenes?limit=${limit}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
      "list",
    );
  }

  const filtered = opts.allStatus ? rows : rows.filter((r) => r.status === "ready");
  const scenes = filtered.map((row) => enrichScene(row, deploy));
  if (opts.json) {
    console.log(JSON.stringify(scenes, null, 2));
    return;
  }
  if (scenes.length === 0) {
    console.log("No scenes.");
    return;
  }
  const headers = [
    ["id", 18],
    ["status", 14],
    ["visibility", 10],
    ["created", 20],
  ];
  console.log(headers.map(([label, width]) => label.padEnd(width)).join("  ") + "  title");
  for (const r of scenes) {
    const cols = [
      r.sceneId.padEnd(18),
      String(r.status ?? "").padEnd(14),
      String(r.visibility ?? "").padEnd(10),
      String(r.created ?? "").padEnd(20),
    ];
    console.log(`${cols.join("  ")}  ${r.title}`);
    if (opts.verbose) {
      console.log(`  ${r.viewerUrl}`);
    }
  }
}

async function cmdDel(sceneId, opts) {
  const config = loadConfig();
  const deploy = deployForViewerLinks(config) || deploymentUrl(config);
  const auth = requireDeleteAuth(config, opts);

  let title = sceneId;
  if (auth.kind === "clerk" || auth.kind === "demo") {
    const rows = await auth.client.query(api.scenes.listMyScenes, { limit: 200 });
    title = rows.find((row) => row._id === sceneId)?.title ?? sceneId;
  }

  if (process.stdin.isTTY && !opts.yes) {
    const ok = await promptYesNo(`Delete ${title} (${sceneId})? [y/N] `);
    if (!ok) {
      console.error("Cancelled.");
      process.exit(1);
    }
  }

  if (auth.kind === "clerk" || auth.kind === "demo") {
    await auth.client.action(api.sceneDelete.deleteMyScene, { sceneId });
  } else {
    await fetchJsonOrExit(
      `${auth.siteUrl}/cli/delete`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sceneId }),
      },
      "delete",
    );
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          sceneId,
          viewerUrl: deploy ? viewerUrlFor(deploy, sceneId) : null,
        },
        null,
        2,
      ),
    );
  } else if (!opts.quiet) {
    console.log("Deleted", sceneId);
  }
}

async function cmdSetView(sceneId, opts) {
  const config = loadConfig();
  const auth = requireDeleteAuth(config, opts);
  const defaultView = parseViewPayload(opts);

  if (auth.kind === "clerk" || auth.kind === "demo") {
    await auth.client.mutation(api.scenes.updateSceneDefaultView, {
      sceneId,
      defaultView,
    });
  } else {
    await fetchJsonOrExit(
      `${auth.siteUrl}/cli/set-view`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sceneId, defaultView }),
      },
      "set-view",
    );
  }

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, sceneId, defaultView }, null, 2));
  } else {
    console.log(`Saved default view for ${sceneId}`);
  }
}

function cmdEmbedSnippet(sceneId, opts) {
  const config = loadConfig();
  const deploy = deployForViewerLinks(config);
  if (!deploy) {
    console.error(
      "Set SPARKLER_DEPLOYMENT_URL, run sparkler login, or add deploymentUrl to config for viewer/embed links.",
    );
    process.exit(1);
  }
  const embedUrl = `${deploy}/embed/${sceneId}`;
  const w = opts.width || "100%";
  const h = opts.height || "480";

  if (opts.format === "md") {
    console.log(
      `[Splat viewer](${embedUrl})\n\n<iframe src="${embedUrl}" title="Gaussian splat" width="${w}" height="${h}" style="border:0;border-radius:8px" allow="fullscreen" loading="lazy"></iframe>`,
    );
    return;
  }

  console.log(`<iframe
  src="${embedUrl}"
  title="Gaussian splat"
  width="${w}"
  height="${h}"
  style="border:0;border-radius:8px"
  allow="fullscreen"
  loading="lazy"
></iframe>`);
}

function printGlobalHelp() {
  console.log(`Usage:
  sparkler login [options]
  sparkler convert <input>... [-o <out.rad>] [-- <build-lod-args>...]
  sparkler host <file> [options]
  sparkler list [options]
  sparkler del <sceneId> [options]
  sparkler set-view <sceneId> [options]
  sparkler embed-snippet <sceneId> [options]

Examples:
  sparkler login
  sparkler host ./scan.spz --demo
  sparkler convert scan.spz -o scan.rad
  sparkler host ./scan.spz --visibility public
  sparkler host ./model.ply --quick
  sparkler list --demo --verbose
  sparkler del jd7abc123 --demo --yes
  sparkler set-view jd7abc123 --view-file ./view.json
  sparkler embed-snippet jd7abc123 --format md

Environment:
  SPARKLER_CONVEX_URL       https://<deployment>.convex.cloud (Clerk or demo CLI path)
  SPARKLER_DEPLOYMENT_URL   Origin of the Sparkler web app (login redirect + viewer links)
  SPARKLER_DEMO            1/true to use unauthenticated demo mode (needs Convex SPARKLER_DEMO_OWNER_SUBJECT)
  SPARKLER_CONVEX_SITE_URL  https://<deployment>.convex.site (HTTP CLI path only)
  SPARKLER_CLI_TOKEN        Bearer = Convex SPARKLER_CLI_SECRET (HTTP CLI path)
  SPARKLER_SPARK_ROOT       Spark repo for convert / default host conversion
  SPARKLER_ENV_FILE         Optional path to a .env file for CLI vars
  SPARKLER_CONFIG           Config JSON path (default ~/.config/sparkler/config.json)

Credentials: ~/.config/sparkler/credentials.json (written by sparkler login)
Auto-loads: .env and .env.local from the current working directory
`);
}

async function main() {
  loadCliEnv();
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    printGlobalHelp();
    process.exit(0);
  }

  if (argv[0] === "convert") {
    const rest = argv.slice(1);
    if (rest[0] === "-h" || rest[0] === "--help") {
      console.log(`sparkler convert <input>... [-o <out.rad>] [-- <build-lod-args>...]
Runs Spark's npm run build-lod in SPARKLER_SPARK_ROOT (or ../spark).
Output defaults to <name>-lod.rad beside each input.`);
      process.exit(0);
    }
    try {
      cmdConvert(rest);
    } catch (e) {
      console.error(e.message || e);
      process.exit(1);
    }
    return;
  }

  const program = new Command();
  program.name("sparkler").description("Sparkler CLI").enablePositionalOptions();

  program
    .command("login")
    .description("Open browser (Clerk) and save Convex JWT to ~/.config/sparkler/credentials.json")
    .option("--port <n>", "Loopback port for token callback", "9876")
    .action(async (opts) => {
      try {
        await cmdLogin(opts);
      } catch (e) {
        console.error(e.message || e);
        process.exit(1);
      }
    });

  program
    .command("host")
    .description(
      "Upload a scene (Clerk JWT, demo mode, or CLI HTTP). Non-.rad files are converted with build-lod unless --no-convert",
    )
    .argument("<file>", "Path to .rad, .spz, .ply, …")
    .option("--title <string>")
    .option("--visibility <vis>", "public | unlisted | private", "unlisted")
    .option("--content-type <mime>")
    .option("--no-convert", "Upload the file as-is (must be an allowed extension)")
    .option("--quick", "When converting, run build-lod without --quality")
    .option("--demo", "Use unauthenticated demo mode (needs Convex SPARKLER_DEMO_OWNER_SUBJECT)")
    .option("--json", "Print JSON for scripting")
    .option("--verbose", "Print labeled viewer + embed URLs")
    .option("--quiet", "Print viewer URL only")
    .option("--open", "Open viewer URL in browser")
    .action(async (file, opts) => {
      try {
        await cmdHost(file, opts);
      } catch (e) {
        console.error(e.message || e);
        process.exit(1);
      }
    });

  program
    .command("list")
    .description("List your scenes (Clerk, demo mode, or HTTP CLI auth)")
    .option("--limit <n>", "Max rows (max 200)", "100")
    .option("--all-status", "Include pending_upload and failed rows")
    .option("--demo", "Use unauthenticated demo mode (needs Convex SPARKLER_DEMO_OWNER_SUBJECT)")
    .option("--verbose", "Print viewer URL below each row")
    .option("--json", "JSON output")
    .action(async (opts) => {
      try {
        await cmdList(opts);
      } catch (e) {
        console.error(e.message || e);
        process.exit(1);
      }
    });

  program
    .command("del")
    .alias("delete")
    .description("Delete a scene and its Tigris object")
    .argument("<sceneId>", "Convex scenes document id")
    .option("-y, --yes", "Skip confirmation prompt")
    .option("--demo", "Use unauthenticated demo mode (needs Convex SPARKLER_DEMO_OWNER_SUBJECT)")
    .option("--json", "JSON output")
    .option("--quiet", "No confirmation line")
    .action(async (sceneId, opts) => {
      try {
        await cmdDel(sceneId, opts);
      } catch (e) {
        console.error(e.message || e);
        process.exit(1);
      }
    });

  program
    .command("set-view")
    .description("Save the default camera view for a scene")
    .argument("<sceneId>", "Convex scenes document id")
    .option("--view-file <path>", "Path to copied view JSON")
    .option("--view-json <json>", "Inline copied view JSON")
    .option("--demo", "Use unauthenticated demo mode (needs Convex SPARKLER_DEMO_OWNER_SUBJECT)")
    .option("--json", "JSON output")
    .action(async (sceneId, opts) => {
      try {
        await cmdSetView(sceneId, opts);
      } catch (e) {
        console.error(e.message || e);
        process.exit(1);
      }
    });

  program
    .command("embed-snippet")
    .description("Print iframe HTML (or markdown) for a hosted scene id")
    .argument("<sceneId>", "Convex scenes document id")
    .option("--width <css>", "CSS width", "100%")
    .option("--height <css>", "CSS height", "480")
    .option("--format <fmt>", "html | md", "html")
    .action((sceneId, opts) => {
      try {
        cmdEmbedSnippet(sceneId, opts);
      } catch (e) {
        console.error(e.message || e);
        process.exit(1);
      }
    });

  program.showHelpAfterError();
  await program.parseAsync(process.argv);
}

main();
