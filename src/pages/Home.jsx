import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import SceneGrid from "../components/SceneGrid.jsx";
const INSTALL_SNIPPET = [
  "curl -fsSL https://raw.githubusercontent.com/61cygni/sparkler/main/public/setup.sh -o setup.sh",
  "bash setup.sh",
  "./bin/sparkler login",
  "./bin/sparkler host ./myscan.spz",
];

export default function Home() {
  const accountStatus = useQuery(api.users.getMyAccountStatus);
  const myScenes = useQuery(api.scenes.listMyScenes, { limit: 50 });
  const signedOut = accountStatus === null || accountStatus?.isDemo === true;

  return (
    <div className="page">
      <h1 style={{ marginTop: 0 }}>Gaussian splat hosting</h1>
      {signedOut ? (
        <section className="terminal-panel" aria-label="CLI quickstart">
          <div className="terminal-panel__header">
            <span>sparkler quickstart</span>
          </div>
          <pre className="terminal-panel__body">
            {INSTALL_SNIPPET.map((line) => `$ ${line}`).join("\n")}
          </pre>
          <p className="terminal-panel__footer">
            Sign in from the CLI, then host with <code>./bin/sparkler host &lt;file&gt;</code>.
          </p>
        </section>
      ) : null}
      {accountStatus?.approvalStatus === "pending" ? (
        <p className="muted">
          Your account is pending approval. Hosting and CLI scene management stay blocked until an
          admin approves you.
        </p>
      ) : null}
      {accountStatus?.approvalStatus === "rejected" ? (
        <p className="muted">
          Your account was rejected. Contact a Sparkler admin if you still need access.
        </p>
      ) : null}

      {!signedOut ? (
        <>
          <h2>Your scenes</h2>
          <SceneGrid
            scenes={myScenes}
            loadingLabel="Loading…"
            emptyLabel="No scenes yet. Use ./bin/sparkler host <file> to add one."
            linkLabel="Open"
            meta={(scene) => `${scene.status} · ${scene.visibility}`}
          />
        </>
      ) : null}
    </div>
  );
}
