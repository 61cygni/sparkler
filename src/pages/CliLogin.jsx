import { SignInButton, useAuth } from "@clerk/clerk-react";
import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";

const clerkPub = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const convexUrl = import.meta.env.VITE_CONVEX_URL ?? "";
const deploymentOrigin =
  import.meta.env.VITE_SPARKLER_PUBLIC_URL?.replace(/\/$/, "") ||
  (typeof window !== "undefined" ? window.location.origin : "");

function parsePort(search) {
  const q = new URLSearchParams(search);
  const raw = q.get("port");
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1 || n > 65535) return null;
  return n;
}

function CliLoginInner() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const port = useMemo(
    () => parsePort(typeof window !== "undefined" ? window.location.search : ""),
    [],
  );

  const sendToCli = useCallback(async () => {
    if (!port) {
      setErr("Missing or invalid ?port= (1–65535). Start the CLI with sparkler login.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const token = await getToken({ template: "convex" });
      if (!token) {
        setErr(
          'No Convex JWT. In Clerk Dashboard, create a JWT template named "convex" (see Convex + Clerk docs).',
        );
        setBusy(false);
        return;
      }
      const receive = `http://127.0.0.1:${port}/receive#t=${encodeURIComponent(token)}`;
      window.location.assign(receive);
    } catch (e) {
      setErr(e?.message ?? String(e));
      setBusy(false);
    }
  }, [getToken, port]);

  return (
    <main style={{ padding: "2rem", maxWidth: 520 }}>
      <h1 style={{ marginTop: 0 }}>Sparkler CLI login</h1>
      {!port ? (
        <p className="muted">Open this page from the CLI so <code>?port=</code> is set.</p>
      ) : (
        <p className="muted">
          Port <code>{port}</code> — after you continue, your browser will open a short loopback page to finish.
        </p>
      )}

      {!isLoaded ? (
        <p>Loading…</p>
      ) : !isSignedIn ? (
        <>
          <p className="muted">Sign in here, then send your token back to the CLI.</p>
          <p>
            <SignInButton mode="modal">
              <button type="button">Sign in</button>
            </SignInButton>
          </p>
        </>
      ) : (
        <>
          <p>
            <button type="button" disabled={busy || !port} onClick={() => void sendToCli()}>
              {busy ? "Redirecting…" : "Send token to CLI"}
            </button>
          </p>
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            Convex: <code style={{ wordBreak: "break-all" }}>{convexUrl}</code>
            <br />
            Saved deployment URL: <code style={{ wordBreak: "break-all" }}>{deploymentOrigin || "(this origin)"}</code>
          </p>
        </>
      )}

      {err ? (
        <p style={{ color: "#f87171", whiteSpace: "pre-wrap" }} role="alert">
          {err}
        </p>
      ) : null}

      <p style={{ marginTop: "2rem" }}>
        <Link to="/">Cancel</Link>
      </p>
    </main>
  );
}

export default function CliLogin() {
  if (!clerkPub) {
    return (
      <main style={{ padding: "2rem", maxWidth: 520 }}>
        <h1 style={{ marginTop: 0 }}>CLI login</h1>
        <p>
          Set <code>VITE_CLERK_PUBLISHABLE_KEY</code> and <code>CLERK_JWT_ISSUER</code> on Convex to use{" "}
          <code>sparkler login</code>.
        </p>
        <p>
          <Link to="/">Home</Link>
        </p>
      </main>
    );
  }
  return <CliLoginInner />;
}
