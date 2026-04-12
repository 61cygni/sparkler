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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadCliEnv() {
  const explicit = process.env.SPARKLER_ENV_FILE;
  const candidates = explicit
    ? [path.resolve(explicit)]
    : [path.resolve(process.cwd(), ".env"), path.resolve(process.cwd(), ".env.local")];

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
  const configPath = fromEnv ?? path.join(homedir(), ".config", "sparkler", "config.json");
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

function credentialsPath() {
  return path.join(homedir(), ".config", "sparkler", "credentials.json");
}

function loadCredentials() {
  const filePath = credentialsPath();
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const json = JSON.parse(readFileSync(filePath, "utf8"));
    if (json.accessToken && json.convexUrl) {
      return json;
    }
  } catch {
    /* ignore invalid local state */
  }
  return null;
}

function saveCredentials(value) {
  const filePath = credentialsPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function boolish(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function inferSiteFromConvexUrl(url) {
  if (!url || typeof url !== "string") {
    return null;
  }
  const trimmed = url.replace(/\/$/, "");
  return trimmed.includes(".convex.cloud")
    ? trimmed.replace(".convex.cloud", ".convex.site")
    : null;
}

function convexCloudUrl(config) {
  const creds = loadCredentials();
  return (
    creds?.convexUrl?.replace(/\/$/, "") ||
    process.env.SPARKLER_CONVEX_URL?.replace(/\/$/, "") ||
    process.env.VITE_CONVEX_URL?.replace(/\/$/, "") ||
    config.convexUrl?.replace(/\/$/, "") ||
    null
  );
}

function convexSiteUrl(config) {
  const creds = loadCredentials();
  return (
    creds?.convexSiteUrl?.replace(/\/$/, "") ||
    process.env.SPARKLER_CONVEX_SITE_URL?.replace(/\/$/, "") ||
    config.convexSiteUrl?.replace(/\/$/, "") ||
    inferSiteFromConvexUrl(creds?.convexUrl) ||
    inferSiteFromConvexUrl(process.env.SPARKLER_CONVEX_URL) ||
    inferSiteFromConvexUrl(process.env.VITE_CONVEX_URL) ||
    inferSiteFromConvexUrl(config.convexUrl) ||
    null
  );
}

function deploymentUrl(config) {
  const creds = loadCredentials();
  return (
    creds?.deploymentUrl?.replace(/\/$/, "") ||
    process.env.SPARKLER_DEPLOYMENT_URL?.replace(/\/$/, "") ||
    config.deploymentUrl?.replace(/\/$/, "") ||
    null
  );
}

function cliToken() {
  return process.env.SPARKLER_CLI_TOKEN || process.env.SPARKLER_API_TOKEN || null;
}

function demoMode(config, opts = {}) {
  if (Boolean(opts.demo)) {
    return true;
  }
  if (loadCredentials()?.accessToken) {
    return false;
  }
  return boolish(process.env.SPARKLER_DEMO) || config.demoMode === true;
}

function viewerUrlFor(deploy, sceneId) {
  return `${deploy}/s/${sceneId}`;
}

function embedUrlFor(deploy, sceneId) {
  return `${deploy}/embed/${sceneId}`;
}

function openBrowser(url) {
  if (process.platform === "darwin") {
    spawnSync("open", [url], { stdio: "ignore" });
  } else if (process.platform === "win32") {
    spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
  } else {
    spawnSync("xdg-open", [url], { stdio: "ignore" });
  }
}

function normalizeVisibilityOrExit(value) {
  if (value === "public" || value === "unlisted" || value === "private") {
    return value;
  }
  console.error("Visibility must be one of: public, unlisted, private");
  process.exit(1);
}

function logPhase(opts, message) {
  if (process.stderr.isTTY && !opts.json) {
    console.error(message);
  }
}

function formatCreatedAt(ts) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) {
    return "";
  }
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
  } catch (error) {
    console.error("Invalid view JSON:", error instanceof Error ? error.message : String(error));
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
  const rl = createInterface({ input: process.stdin, output: process.stdout });
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
    const sockets = new Set();
    const server = createServer((req, res) => {
      const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      if (req.method === "GET" && url.pathname === "/receive") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          Connection: "close",
        });
        res.end(RECEIVE_PAGE);
        return;
      }
      if (req.method === "POST" && url.pathname === "/token") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          if (settled) {
            res.writeHead(409);
            res.end("Already completed");
            return;
          }
          try {
            const json = JSON.parse(body);
            if (!json.accessToken || typeof json.accessToken !== "string") {
              res.writeHead(400);
              res.end("Expected JSON { accessToken }");
              return;
            }
            settled = true;
            res.writeHead(200, {
              "Content-Type": "text/plain; charset=utf-8",
              Connection: "close",
            });
            res.end("OK", () => {
              resolve({ accessToken: json.accessToken });
              server.close();
              if (typeof server.closeAllConnections === "function") {
                server.closeAllConnections();
              }
              for (const socket of sockets) {
                socket.destroy();
              }
            });
          } catch (error) {
            res.writeHead(400);
            res.end(error instanceof Error ? error.message : String(error));
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      try {
        onListening?.();
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

async function fetchJson(url, init, label) {
  const response = await fetch(url, init);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!response.ok) {
    const message = json?.error ?? text ?? `${label} failed`;
    throw new Error(message);
  }
  return json;
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

  const siteUrl = convexSiteUrl(config) ?? inferSiteFromConvexUrl(convexUrl);
  const loginUrl = `${deploy}/cli-login?port=${port}`;
  console.log(`If the browser does not open, visit:\n  ${loginUrl}`);
  console.log("After signing in, click “Send token to CLI”.");
  console.log(`Listening on http://127.0.0.1:${port} …`);

  const { accessToken } = await waitForCliToken(port, () => openBrowser(loginUrl));
  saveCredentials({
    accessToken,
    convexUrl,
    convexSiteUrl: siteUrl,
    deploymentUrl: deploy,
  });
  console.log(`Stored Clerk → Convex token in ${credentialsPath()}`);

  if (siteUrl) {
    try {
      const status = await fetchJson(
        `${siteUrl}/api/cli/me`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${accessToken}` },
        },
        "login status",
      );
      if (status.approvalStatus === "approved") {
        console.log("Account status: approved");
      } else if (status.approvalStatus === "pending") {
        console.log("Account status: pending approval");
      } else if (status.approvalStatus === "rejected") {
        console.log("Account status: rejected");
      }
    } catch (error) {
      console.error(
        "Stored credentials, but could not verify account status:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

function resolveSparkRoot() {
  const env = process.env.SPARKLER_SPARK_ROOT;
  const candidates = [
    env,
    path.resolve(process.cwd(), "spark"),
    path.resolve(process.cwd(), "..", "spark"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const packagePath = path.join(candidate, "package.json");
    const cargoPath = path.join(candidate, "rust", "build-lod", "Cargo.toml");
    if (!existsSync(packagePath) || !existsSync(cargoPath)) {
      continue;
    }
    try {
      const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
      if (pkg.scripts?.["build-lod"]) {
        return path.resolve(candidate);
      }
    } catch {
      /* ignore candidate */
    }
  }

  throw new Error(
    "Could not find a Spark checkout with npm run build-lod. Set SPARKLER_SPARK_ROOT to the spark repo root.",
  );
}

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
    const arg = argv[i];
    if (arg === "--") {
      passthrough = argv.slice(i + 1);
      break;
    }
    if (arg === "-o" || arg === "--output") {
      output = argv[i + 1];
      if (!output) {
        throw new Error(`${arg} requires a path`);
      }
      i += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positional.push(arg);
    i += 1;
  }
  if (!positional.length) {
    throw new Error("Provide at least one input file.");
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
    const result = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["run", "build-lod", "--", abs, ...passthrough],
      { cwd: sparkRoot, stdio: "inherit", shell: false },
    );
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
    const produced = defaultRadPath(abs);
    if (!existsSync(produced)) {
      console.error(`Expected output missing: ${produced}`);
      process.exit(1);
    }
    if (output) {
      if (positional.length > 1) {
        console.warn("Ignoring -o when multiple inputs were converted.");
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
      /* ignore cleanup failures */
    }
  };

  try {
    const base = path.basename(absPath);
    const tmpInput = path.join(tmpRoot, base);
    copyFileSync(absPath, tmpInput);
    const sparkRoot = resolveSparkRoot();
    const qualityArgs = opts.quick ? [] : ["--quality"];
    const result = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["run", "build-lod", "--", tmpInput, ...qualityArgs],
      { cwd: sparkRoot, stdio: "inherit", shell: false },
    );
    if (result.status !== 0) {
      cleanup();
      process.exit(result.status ?? 1);
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
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function putFileStream(url, headers, filePath) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Content-Length", String(statSync(filePath).size));
  const stream = createReadStream(filePath);
  try {
    return await fetch(url, {
      method: "PUT",
      headers: requestHeaders,
      duplex: "half",
      body: stream,
    });
  } catch (error) {
    if (String(error).includes("duplex")) {
      const body = readFileSync(filePath);
      return await fetch(url, { method: "PUT", headers: requestHeaders, body });
    }
    throw error;
  }
}

function requireDeploy(config, message) {
  const deploy = deploymentUrl(config);
  if (!deploy) {
    console.error(message);
    process.exit(1);
  }
  return deploy;
}

function requireUserHttpAuth(config) {
  const creds = loadCredentials();
  const siteUrl = convexSiteUrl(config);
  const deploy = deploymentUrl(config);
  if (!creds?.accessToken || !siteUrl || !deploy) {
    return null;
  }
  return {
    kind: "user",
    token: creds.accessToken,
    siteUrl,
    deploy,
  };
}

function requireAdminHttpAuth(config) {
  const token = cliToken();
  const siteUrl = convexSiteUrl(config);
  const deploy = deploymentUrl(config);
  if (!token || !siteUrl) {
    return null;
  }
  return {
    kind: "admin",
    token,
    siteUrl,
    deploy,
  };
}

function requireDemoAuth(config, opts = {}) {
  if (!demoMode(config, opts)) {
    return null;
  }
  const url = convexCloudUrl(config);
  const deploy = deploymentUrl(config);
  if (!url || !deploy) {
    console.error(
      "Demo mode needs SPARKLER_CONVEX_URL and SPARKLER_DEPLOYMENT_URL (or values in config).",
    );
    process.exit(1);
  }
  return {
    kind: "demo",
    client: new ConvexHttpClient(url),
    deploy,
  };
}

function resolveHostAuth(config, opts = {}) {
  const demo = requireDemoAuth(config, opts);
  if (demo) {
    return demo;
  }
  const user = requireUserHttpAuth(config);
  if (user) {
    return user;
  }
  const admin = requireAdminHttpAuth(config);
  if (admin) {
    return admin;
  }
  console.error(
    "Authenticate with Clerk: run sparkler login, or enable demo mode (--demo / SPARKLER_DEMO=1), or use admin automation with SPARKLER_CLI_TOKEN and SPARKLER_CONVEX_SITE_URL.",
  );
  process.exit(1);
}

function resolveSceneAuth(config, opts = {}) {
  return resolveHostAuth(config, opts);
}

async function fetchCli(auth, endpoint, init, label) {
  const prefix = auth.kind === "user" ? "/api/cli" : "/cli";
  return await fetchJson(
    `${auth.siteUrl}${prefix}/${endpoint}`,
    {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${auth.token}`,
      },
    },
    label,
  );
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

async function hostWithDemo(client, deploy, uploadPath, basename, stat, contentType, visibility, opts) {
  const created = await client.mutation("scenes:createScene", {
    filename: basename,
    title: opts.title || basename,
    visibility,
    contentType,
    byteSize: stat.size,
  });
  const sceneId = created.sceneId;
  const storageKey = created.storageKey;
  const presign = await client.action("tigris:presignUpload", {
    sceneId,
    contentType,
    byteSize: stat.size,
  });

  logPhase(opts, "Uploading…");
  const putRes = await putFileStream(presign.url, presign.headers, uploadPath);
  if (!putRes.ok) {
    console.error("PUT to storage failed:", putRes.status, await putRes.text());
    await client.mutation("scenes:markSceneFailed", { sceneId }).catch(() => {});
    process.exit(1);
  }

  await client.mutation("scenes:finalizeScene", {
    sceneId,
    byteSize: stat.size,
    contentType,
  });

  logPhase(opts, "Done.");
  printHostResult(
    sceneId,
    deploy,
    basename,
    visibility,
    storageKey,
    stat.size,
    opts.title || basename,
    opts,
  );
}

async function hostWithHttp(auth, uploadPath, basename, stat, contentType, visibility, opts) {
  const session = await fetchCli(
    auth,
    "upload-session",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: basename,
        title: opts.title || basename,
        visibility,
        contentType,
        byteSize: stat.size,
      }),
    },
    "upload-session",
  );

  logPhase(opts, "Uploading…");
  const putRes = await putFileStream(session.uploadUrl, session.headers, uploadPath);
  if (!putRes.ok) {
    console.error("PUT to storage failed:", putRes.status, await putRes.text());
    await fetchCli(
      auth,
      "mark-failed",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sceneId: session.sceneId }),
      },
      "mark-failed",
    ).catch(() => {});
    process.exit(1);
  }

  await fetchCli(
    auth,
    "finalize",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sceneId: session.sceneId,
        byteSize: stat.size,
        contentType,
      }),
    },
    "finalize",
  );

  logPhase(opts, "Done.");
  printHostResult(
    session.sceneId,
    auth.deploy,
    basename,
    visibility,
    session.storageKey,
    stat.size,
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
    const stat = statSync(uploadPath);
    const contentType = opts.contentType || guessContentType(displayBasename);
    const visibility = normalizeVisibilityOrExit(opts.visibility ?? "unlisted");
    const auth = resolveHostAuth(config, opts);
    if (auth.kind === "demo") {
      await hostWithDemo(
        auth.client,
        auth.deploy,
        uploadPath,
        displayBasename,
        stat,
        contentType,
        visibility,
        opts,
      );
    } else {
      await hostWithHttp(auth, uploadPath, displayBasename, stat, contentType, visibility, opts);
    }
  } finally {
    cleanup();
  }
}

async function cmdList(opts) {
  const config = loadConfig();
  const limit = Math.min(Number.parseInt(String(opts.limit ?? "100"), 10) || 100, 200);
  const deploy = requireDeploy(
    config,
    "Set SPARKLER_DEPLOYMENT_URL, run sparkler login, or add deploymentUrl to config for viewer links.",
  );
  const auth = resolveSceneAuth(config, opts);

  let rows;
  if (auth.kind === "demo") {
    rows = await auth.client.query("scenes:listMyScenes", { limit });
  } else {
    rows = await fetchCli(auth, `scenes?limit=${limit}`, { method: "GET" }, "list");
  }

  const filtered = opts.allStatus ? rows : rows.filter((row) => row.status === "ready");
  const scenes = filtered.map((row) => enrichScene(row, deploy));
  if (opts.json) {
    console.log(JSON.stringify(scenes, null, 2));
    return;
  }
  if (!scenes.length) {
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
  for (const scene of scenes) {
    const cols = [
      scene.sceneId.padEnd(18),
      String(scene.status ?? "").padEnd(14),
      String(scene.visibility ?? "").padEnd(10),
      String(scene.created ?? "").padEnd(20),
    ];
    console.log(`${cols.join("  ")}  ${scene.title}`);
    if (opts.verbose) {
      console.log(`  ${scene.viewerUrl}`);
    }
  }
}

async function cmdDel(sceneId, opts) {
  const config = loadConfig();
  const deploy = deploymentUrl(config);
  const auth = resolveSceneAuth(config, opts);
  let title = sceneId;

  if (auth.kind === "demo") {
    const rows = await auth.client.query("scenes:listMyScenes", { limit: 200 });
    title = rows.find((row) => row._id === sceneId)?.title ?? sceneId;
  } else {
    const rows = await fetchCli(auth, "scenes?limit=200", { method: "GET" }, "list");
    title = rows.find((row) => row._id === sceneId)?.title ?? sceneId;
  }

  if (process.stdin.isTTY && !opts.yes) {
    const ok = await promptYesNo(`Delete ${title} (${sceneId})? [y/N] `);
    if (!ok) {
      console.error("Cancelled.");
      process.exit(1);
    }
  }

  if (auth.kind === "demo") {
    await auth.client.action("sceneDelete:deleteMyScene", { sceneId });
  } else {
    await fetchCli(
      auth,
      "delete",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
  const auth = resolveSceneAuth(config, opts);
  const defaultView = parseViewPayload(opts);

  if (auth.kind === "demo") {
    await auth.client.mutation("scenes:updateSceneDefaultView", {
      sceneId,
      defaultView,
    });
  } else {
    await fetchCli(
      auth,
      "set-view",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

async function cmdSetVisibility(sceneId, visibilityInput, opts) {
  const config = loadConfig();
  const auth = resolveSceneAuth(config, opts);
  const visibility = normalizeVisibilityOrExit(visibilityInput);

  if (auth.kind === "demo") {
    await auth.client.mutation("scenes:updateSceneVisibility", {
      sceneId,
      visibility,
    });
  } else {
    await fetchCli(
      auth,
      "set-visibility",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sceneId, visibility }),
      },
      "set-visibility",
    );
  }

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, sceneId, visibility }, null, 2));
  } else {
    console.log(`Set visibility for ${sceneId} to ${visibility}`);
  }
}

async function cmdAdoptDemoScenes(opts) {
  const config = loadConfig();
  if (demoMode(config, opts)) {
    console.error("adopt-demo-scenes requires a real Clerk login. Do not use --demo.");
    process.exit(1);
  }
  const auth = requireUserHttpAuth(config);
  if (!auth) {
    console.error("Run sparkler login first to save a Clerk-issued Convex token.");
    process.exit(1);
  }

  const result = await fetchCli(
    auth,
    "adopt-demo-scenes",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchSize: Number.parseInt(String(opts.batchSize ?? "200"), 10) || 200,
      }),
    },
    "adopt-demo-scenes",
  );

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    `Adopted ${result.updated} scene(s) from ${result.demoSubject} to ${result.adoptedSubject}.`,
  );
  if (result.hasMore) {
    console.log("More demo-owned scenes may remain; run the command again if needed.");
  }
}

function cmdDashboard(opts) {
  const config = loadConfig();
  const deploy = requireDeploy(
    config,
    "Set SPARKLER_DEPLOYMENT_URL, run sparkler login, or add deploymentUrl to config for dashboard links.",
  );
  if (opts.json) {
    console.log(JSON.stringify({ dashboardUrl: deploy }, null, 2));
  } else {
    console.log(deploy);
  }
  openBrowser(deploy);
}

function cmdEmbedSnippet(sceneId, opts) {
  const config = loadConfig();
  const deploy = requireDeploy(
    config,
    "Set SPARKLER_DEPLOYMENT_URL, run sparkler login, or add deploymentUrl to config for viewer/embed links.",
  );
  const embedUrl = `${deploy}/embed/${sceneId}`;
  const width = opts.width || "100%";
  const height = opts.height || "480";

  if (opts.format === "md") {
    console.log(
      `[Splat viewer](${embedUrl})\n\n<iframe src="${embedUrl}" title="Gaussian splat" width="${width}" height="${height}" style="border:0;border-radius:8px" allow="fullscreen" loading="lazy"></iframe>`,
    );
    return;
  }

  console.log(`<iframe
  src="${embedUrl}"
  title="Gaussian splat"
  width="${width}"
  height="${height}"
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
  sparkler dashboard [options]
  sparkler list [options]
  sparkler del <sceneId> [options]
  sparkler set-visibility <sceneId> <visibility> [options]
  sparkler set-view <sceneId> [options]
  sparkler adopt-demo-scenes [options]
  sparkler embed-snippet <sceneId> [options]

Examples:
  sparkler login
  sparkler host ./scan.spz
  sparkler convert scan.spz -o scan.rad
  sparkler dashboard
  sparkler list --verbose
  sparkler del jd7abc123 --yes
  sparkler set-visibility jd7abc123 public
  sparkler set-view jd7abc123 --view-file ./view.json
  sparkler adopt-demo-scenes
  sparkler embed-snippet jd7abc123 --format md

Environment:
  SPARKLER_CONVEX_URL       https://<deployment>.convex.cloud (login or demo mode)
  SPARKLER_CONVEX_SITE_URL  https://<deployment>.convex.site (optional override for HTTP routes)
  SPARKLER_DEPLOYMENT_URL   Origin of the Sparkler web app
  SPARKLER_SPARK_ROOT       Path to a Spark checkout for convert/default host conversion
  SPARKLER_DEMO             1/true enables local demo mode
  SPARKLER_CLI_TOKEN        Shared secret for admin automation routes only
`);
}

function buildProgram() {
  const program = new Command();
  program
    .name("sparkler")
    .description("Host and manage Gaussian splats with Sparkler")
    .helpOption("-h, --help", "Show help")
    .showHelpAfterError(true)
    .addHelpText("beforeAll", "")
    .addHelpText("afterAll", "");

  program
    .command("login")
    .description("Open Clerk login in the browser and save a Convex token")
    .option("--port <n>", "Loopback port", "9876")
    .action(async (opts) => {
      try {
        await cmdLogin(opts);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  program
    .command("convert")
    .allowUnknownOption(true)
    .argument("[files...]", "Input files")
    .description("Convert one or more splat inputs to .rad using Spark build-lod")
    .action((files, cmd) => {
      try {
        cmdConvert([...files, ...cmd.args]);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  program
    .command("dashboard")
    .description("Open the Sparkler dashboard in your browser")
    .option("--json", "JSON output")
    .action((opts) => {
      try {
        cmdDashboard(opts);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  program
    .command("host")
    .argument("<file>", "Local splat file or .rad to upload")
    .description("Upload a splat file and print its viewer URL")
    .option("--title <title>", "Optional scene title")
    .option("--visibility <visibility>", "public | unlisted | private", "unlisted")
    .option("--content-type <mime>", "Override MIME type")
    .option("--no-convert", "Upload the input as-is")
    .option("--quick", "Use Spark's quicker LoD preset")
    .option("--demo", "Use unauthenticated demo mode")
    .option("--json", "JSON output")
    .option("--verbose", "Print labeled URLs")
    .option("--open", "Open the viewer after upload")
    .action(async (file, opts) => {
      try {
        await cmdHost(file, opts);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  program
    .command("list")
    .description("List your hosted scenes")
    .option("--limit <n>", "Maximum scenes to return", "100")
    .option("--all-status", "Include pending and failed scenes")
    .option("--demo", "Use unauthenticated demo mode")
    .option("--json", "JSON output")
    .option("--verbose", "Print viewer URLs")
    .action(async (opts) => {
      try {
        await cmdList(opts);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  program
    .command("del")
    .description("Delete a hosted scene")
    .argument("<sceneId>", "Convex scenes document id")
    .option("--demo", "Use unauthenticated demo mode")
    .option("-y, --yes", "Skip confirmation")
    .option("--quiet", "Do not print confirmation")
    .option("--json", "JSON output")
    .action(async (sceneId, opts) => {
      try {
        await cmdDel(sceneId, opts);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  program
    .command("set-visibility")
    .description("Update a scene's visibility")
    .argument("<sceneId>", "Convex scenes document id")
    .argument("<visibility>", "public | unlisted | private")
    .option("--demo", "Use unauthenticated demo mode")
    .option("--json", "JSON output")
    .action(async (sceneId, visibility, opts) => {
      try {
        await cmdSetVisibility(sceneId, visibility, opts);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  program
    .command("set-view")
    .description("Save a scene's default camera view")
    .argument("<sceneId>", "Convex scenes document id")
    .option("--view-file <path>", "Path to copied view JSON")
    .option("--view-json <json>", "Inline view JSON")
    .option("--demo", "Use unauthenticated demo mode")
    .option("--json", "JSON output")
    .action(async (sceneId, opts) => {
      try {
        await cmdSetView(sceneId, opts);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  program
    .command("adopt-demo-scenes")
    .description("Move demo-owned scenes onto your signed-in Clerk account")
    .option("--batch-size <n>", "Max scenes to adopt in one run", "200")
    .option("--json", "JSON output")
    .action(async (opts) => {
      try {
        await cmdAdoptDemoScenes(opts);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  program
    .command("embed-snippet")
    .description("Print an iframe snippet for a hosted scene")
    .argument("<sceneId>", "Convex scenes document id")
    .option("--format <format>", "html | md", "html")
    .option("--width <value>", "Iframe width", "100%")
    .option("--height <value>", "Iframe height", "480")
    .action((sceneId, opts) => {
      try {
        cmdEmbedSnippet(sceneId, opts);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  return program;
}

loadCliEnv();

const program = buildProgram();
if (process.argv.length <= 2) {
  printGlobalHelp();
  process.exit(0);
}
program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
