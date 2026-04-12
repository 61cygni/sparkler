# Sparkler

Vite + React (JavaScript) app for hosting Gaussian splats: **Convex** (metadata + presigned URLs), **Tigris** (S3-compatible storage), and **Spark** 2.0 for rendering and optional local `.rad` conversion.

## Prerequisites

- Node 18+
- A [Convex](https://www.convex.dev/) project
- A [Tigris](https://www.tigrisdata.com/) bucket (or other S3-compatible API)
- Optional for `sparkler convert` / default non-`.rad` CLI uploads: a local Spark checkout with `npm run build-lod`

## Setup

1. **Install**

   ```bash
   cd sparkler
   npm install
   ```

2. **Convex**

   ```bash
   npx convex dev
   ```

   Link or create a project. This overwrites `convex/_generated/*` with full types.

3. **Convex environment variables** (dashboard -> Settings -> Environment Variables)

   | Variable | Purpose |
   |----------|---------|
   | `TIGRIS_ACCESS_KEY_ID` | Tigris access key |
   | `TIGRIS_SECRET_ACCESS_KEY` | Tigris secret |
   | `TIGRIS_BUCKET` | Bucket name |
   | `TIGRIS_ENDPOINT` | e.g. `https://fly.storage.tigris.dev` (see Tigris docs) |
   | `TIGRIS_REGION` | Optional, default `auto` |
   | `TIGRIS_PUBLIC_BASE_URL` | Optional. If set, public/unlisted scene files can use `GET` at `{base}/{storageKey}` (bucket must allow public read + CORS). The app still uses signed URLs for thumbnails. |
   | `SPARKLER_DEMO_OWNER_SUBJECT` | **Dev only.** Fake "user id" for uploads when Clerk is not configured. Also powers CLI `--demo` / `SPARKLER_DEMO=1`. Remove in production. |
   | `SPARKLER_CLI_SECRET` | **Admin automation only.** Shared secret for the owner-only `/cli/*` HTTP routes. Do not distribute this to normal users. |
   | `SPARKLER_CLI_OWNER_SUBJECT` | **Admin automation only.** Stable owner id stored on scenes created via shared-secret `/cli/*` routes (e.g. `cli:prod`). Must be set if `SPARKLER_CLI_SECRET` is set. |
   | `CLERK_JWT_ISSUER` | If using Clerk: issuer URL (e.g. `https://your-app.clerk.accounts.dev`). When set, `convex/auth.config.ts` enables Clerk auth; if unset, Convex stays in demo/no-auth mode. |
   | `SPARKLER_ADMIN_SUBJECTS` | Optional comma-separated Clerk subjects that should auto-provision as approved admins. |
   | `SPARKLER_ADMIN_EMAILS` | Optional comma-separated email allowlist for approved admins. |
   | `SPARKLER_AUTO_APPROVE_EMAILS` | Optional comma-separated email allowlist that skips manual approval. |
   | `SPARKLER_AUTO_APPROVE_DOMAINS` | Optional comma-separated email domains that skip manual approval (for example `mycompany.com`). |

4. **Frontend `.env.local`**

   ```bash
   cp .env.local.example .env.local
   ```

   Set `VITE_CONVEX_URL` from the Convex dashboard.  
   Optional: `VITE_CLERK_PUBLISHABLE_KEY` for [Clerk](https://clerk.com/) + Convex ([integration guide](https://docs.convex.dev/auth/clerk)).

### Clerk setup for `sparkler login`

If you want the CLI login flow to work end to end, make sure all three of these are configured:

1. In Clerk, create a JWT template named `convex`.
2. In Convex environment variables, set `CLERK_JWT_ISSUER` to your Clerk issuer URL.
3. In the frontend build environment, set `VITE_CLERK_PUBLISHABLE_KEY`.

After those are set, `sparkler login` opens `/cli-login`, Clerk signs you in, the page requests a Convex JWT from the `convex` template, and the CLI stores it in `$XDG_CONFIG_HOME/sparkler/credentials.json` (or `~/.config/sparkler/credentials.json` if `XDG_CONFIG_HOME` is unset).

### Access approval

Clerk login and Sparkler access are now separate steps:

1. A user signs in with Clerk.
2. Sparkler provisions a `users` record with `pending`, `approved`, or `rejected` status.
3. Protected actions like `host`, `list`, `del`, `set-view`, and `set-visibility` require `approved`.

Use `/admin/access` in the web app to review and approve pending users. Users matching `SPARKLER_ADMIN_*` or `SPARKLER_AUTO_APPROVE_*` can be approved automatically on first sign-in.

5. **Tigris CORS**

   Allow your app origin (e.g. `http://localhost:5173`) for `GET`, `HEAD`, and `PUT` as needed.

6. **Run**

   ```bash
   npx convex dev   # terminal 1 - keeps backend in sync
   npm run dev      # terminal 2 - Vite
   ```

## CLI (`sparkler`)

Binary: the publishable package now lives in `packages/cli` and installs as `sparkler`. Inside this repo, the legacy wrapper at `node cli/bin/sparkler.mjs` still forwards to the packaged CLI.

### Installer script

If you host the app on Convex, the same site can also serve a shell installer at `/setup.sh`.
That installer now downloads the Sparkler source tarball from GitHub, runs `npm install` inside `packages/cli`, and by default installs everything into the current directory so the setup is self-contained. End users need **Node 18+** and **npm**, but they do **not** need to install from the npm registry.

Safer flow:

```bash
curl -fsSL https://<deployment>.convex.site/setup.sh -o setup.sh
bash setup.sh
```

Direct pipe-to-shell:

```bash
curl -fsSL https://<deployment>.convex.site/setup.sh | bash
```

The installer:

1. Detects macOS/Linux and checks that Node 18+, `npm`, `curl`, and `tar` are installed.
2. Downloads the Sparkler source tarball from GitHub and runs `npm install` inside `packages/cli`.
3. Writes all local state into the current directory by default:
   - `./.sparkler` for the installed package
   - `./bin/sparkler` for the launcher
   - `./.config/sparkler` for config and saved login credentials
   - `./.npm-cache` for npm's install cache
4. Optionally writes `./.config/sparkler/config.json` from the deployment URL you enter, so `./bin/sparkler login` can work immediately.
5. Verifies `./bin/sparkler --help` and prints the next steps, including the approval-gated login flow.

For local development from this repo, you can also run:

```bash
bash ./scripts/setup.sh
```

### GitHub source installer settings

The installer defaults to the GitHub repo `61cygni/sparkler` and downloads the `main` branch source tarball. You can override that with:

- `SPARKLER_GITHUB_REPO` to point at another repo
- `SPARKLER_GITHUB_REF` to pin a tag, branch, or commit-ish
- `SPARKLER_ROOT_DIR`, `SPARKLER_INSTALL_DIR`, `SPARKLER_BIN_DIR`, `XDG_CONFIG_HOME`, or `SPARKLER_NPM_CACHE_DIR` if you want a non-default layout

| Command | Purpose |
|---------|---------|
| `sparkler login` | Opens `/cli-login` (Clerk). After sign-in, loopback saves your Convex JWT to `$XDG_CONFIG_HOME/sparkler/credentials.json` (the installer sets this to `./.config/sparkler/credentials.json` by default). |
| `sparkler logout` | Removes the saved CLI token from `$XDG_CONFIG_HOME/sparkler/credentials.json` and, when the deployment URL is known, opens `/cli-logout` to sign out the active Clerk browser session too. |
| `sparkler convert <input>... [-o out.rad] [-- <build-lod-args>]` | Runs Spark's `npm run build-lod` (needs Rust toolchain + `../spark` or `SPARKLER_SPARK_ROOT`). Writes `<name>-lod.rad` next to each input unless `-o` is used (single input only). |
| `sparkler host <file>` | **Clerk (default):** authenticated `/api/cli/*` routes on `*.convex.site` + presigned PUT + finalize. **Demo:** unauthenticated Convex calls with `--demo` / `SPARKLER_DEMO=1` and Convex `SPARKLER_DEMO_OWNER_SUBJECT`. **Admin automation:** shared-secret `/cli/*` + `SPARKLER_CLI_TOKEN`. Non-`.rad` files run through `build-lod` in a temp dir unless `--no-convert`. |
| `sparkler dashboard` | Opens the Sparkler dashboard using the saved deployment URL from `sparkler login` or `SPARKLER_DEPLOYMENT_URL`. |
| `sparkler view <sceneId>` | Opens the full viewer page for a specific scene and prints its URL. |
| `sparkler list` | Lists your scenes. Works with `sparkler login`, demo mode, or the admin shared-secret env fallback. |
| `sparkler del <sceneId>` | Deletes Tigris object and DB row. Works with `sparkler login`, demo mode, or the admin shared-secret env fallback. |
| `sparkler set-visibility <sceneId> <visibility>` | Changes an existing scene to `public`, `unlisted`, or `private`. Works with `sparkler login`, demo mode, or the admin shared-secret env fallback. |
| `sparkler set-view <sceneId>` | Saves the scene's default camera view from copied HUD JSON (`--view-file` or `--view-json`). Works with `sparkler login`, demo mode, or the admin shared-secret env fallback. |
| `sparkler adopt-demo-scenes` | One-time migration: moves scenes owned by `SPARKLER_DEMO_OWNER_SUBJECT` onto your signed-in Clerk account. Requires `sparkler login`; do not use `--demo`. |
| `sparkler embed-snippet <sceneId>` | Prints iframe HTML (or `--format md`) using saved deployment URL or `SPARKLER_DEPLOYMENT_URL`. |

**Public Clerk CLI (`login`, `host`, `list`, `del`):**

If the saved Clerk JWT has expired, user-scoped CLI commands now detect that locally and tell you to run `sparkler login` again instead of surfacing a raw Convex OIDC verification error.

| Variable | Purpose |
|----------|---------|
| `SPARKLER_CONVEX_URL` | `https://<deployment>.convex.cloud` |
| `SPARKLER_DEPLOYMENT_URL` | Origin of the Sparkler app (opens `/cli-login`, viewer/embed links). |
| `SPARKLER_CONVEX_SITE_URL` | Optional override for the authenticated `*.convex.site` HTTP routes. Usually inferred from `SPARKLER_CONVEX_URL`. |

**Demo CLI (no Clerk, local dev):**

| Variable | Purpose |
|----------|---------|
| `SPARKLER_DEMO` | Set to `1` / `true` to use unauthenticated CLI demo mode (or pass `--demo`) |
| `SPARKLER_CONVEX_URL` | `https://<deployment>.convex.cloud` |
| `SPARKLER_DEPLOYMENT_URL` | Origin of the Sparkler app (`http://localhost:5173` in dev) |

**Admin automation CLI (optional, shared secret):**

| Variable | Purpose |
|----------|---------|
| `SPARKLER_CONVEX_SITE_URL` | `https://<deployment>.convex.site` (HTTP routes from `convex/http.ts`) |
| `SPARKLER_CLI_TOKEN` | Same value as Convex `SPARKLER_CLI_SECRET` |

**Common:**

| Variable | Purpose |
|----------|---------|
| `SPARKLER_SPARK_ROOT` | Path to Spark repo for `convert` / default `host` conversion (optional if `../spark` exists) |

Optional config file: `$XDG_CONFIG_HOME/sparkler/config.json` with `convexSiteUrl`, `deploymentUrl`, `convexUrl`. Without `XDG_CONFIG_HOME`, that defaults to `~/.config/sparkler/config.json`.

The CLI now auto-loads `.env` and `.env.local` from your current working directory. If you want a different file, set `SPARKLER_ENV_FILE=/path/to/file.env`.

### Adopting old demo scenes

If you uploaded scenes before Clerk was configured and they were owned by `SPARKLER_DEMO_OWNER_SUBJECT`, you can move them onto your real Clerk account after running `sparkler login`:

```bash
node cli/bin/sparkler.mjs adopt-demo-scenes
```

If you have a lot of scenes, run it again while it reports more remaining work.

Once a scene is yours, you can change it to public with:

```bash
node cli/bin/sparkler.mjs set-visibility <sceneId> public
```

### No-auth local testing

If you want to test without Clerk:

1. In Convex env, set `SPARKLER_DEMO_OWNER_SUBJECT=demo:local`.
2. Do **not** set `VITE_CLERK_PUBLISHABLE_KEY` in `.env.local`.
3. In a `.env` file in the repo root, set:

   ```dotenv
   SPARKLER_DEMO=1
   SPARKLER_CONVEX_URL=https://<deployment>.convex.cloud
   SPARKLER_DEPLOYMENT_URL=http://localhost:5173
   ```

4. Then run:

   ```bash
   npx convex dev
   npm run dev
   node cli/bin/sparkler.mjs host ./path/to/scan.spz --demo
   node cli/bin/sparkler.mjs list --demo
   node cli/bin/sparkler.mjs set-view <sceneId> --demo --view-file ./view.json
   ```

This path is for local development only. Remove `SPARKLER_DEMO_OWNER_SUBJECT` before production.

## Host On Convex

Static hosting is wired through `@convex-dev/static-hosting`, so the same Convex deployment can serve the authenticated public CLI routes under `/api/cli/*`, the shared-secret admin automation routes under `/cli/*`, and the built Vite app.

1. Keep the backend synced locally at least once:

   ```bash
   npx convex dev
   ```

2. For the normal dev workflow, upload the site to your dev Convex deployment:

   ```bash
   npm run deploy:site
   ```

   This builds the Vite app with the dev Convex URL and uploads the static assets to your dev `*.convex.site`.

3. For production, use the explicit production scripts:

   ```bash
   npm run deploy:site:prod
   npm run deploy:all:prod
   ```

   `deploy:site:prod` uploads only the frontend to the production Convex site. `deploy:all:prod` runs the full production backend deploy plus site upload.

4. After deploy, set your CLI/app base URL to the hosted site you actually want to use:

   ```dotenv
   SPARKLER_DEPLOYMENT_URL=https://<deployment>.convex.site
   SPARKLER_CONVEX_SITE_URL=https://<deployment>.convex.site
   ```

The frontend also falls back to deriving the Convex cloud URL automatically when it is running on `*.convex.site`, and the upload commands use `--build` so the correct Convex URL is injected for the selected deployment.

See [`cli-design.md`](./cli-design.md) for the full design.

## Scripts

- `npm run dev` - Vite dev server  
- `npm run build` - production client build  
- `npm run convex:dev` / `npm run convex:deploy` - Convex CLI shortcuts  
- `npm run deploy:site` - upload the built frontend to the dev Convex site  
- `npm run deploy:site:prod` - upload the built frontend to the production Convex site  
- `npm run deploy:all:prod` - deploy the production Convex backend and hosted frontend together  

## Routes

- `/` - Public gallery + your scenes  
- `/admin/access` - Admin approval dashboard for pending users  
- `/upload` - Presigned PUT upload flow  
- `/s/:sceneId` - Full viewer (Spark `SparkRenderer` + `SplatMesh`, FPS controls, view HUD, thumbnail capture)  
- `/embed/:sceneId` - Minimal viewer for iframes  
- `/cli-login` - Clerk loopback for `sparkler login`  

## Note on `convex/_generated`

The repo includes minimal generated stubs so `npm run build` works before you run Convex. After `npx convex dev`, those files are replaced with the real codegen output - commit or regenerate as your team prefers.
