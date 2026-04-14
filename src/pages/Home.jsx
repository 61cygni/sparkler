import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import CliQuickstartPanel from "../components/CliQuickstartPanel.jsx";
import SceneGrid from "../components/SceneGrid.jsx";

export default function Home() {
  const accountStatus = useQuery(api.users.getMyAccountStatus);
  const myScenes = useQuery(api.scenes.listMyScenes, { limit: 50 });
  const signedOut = accountStatus === null || accountStatus?.isDemo === true;

  return (
    <div className="page">
      <h1 style={{ marginTop: 0 }}>Gaussian splat hosting</h1>
      {signedOut ? (
        <CliQuickstartPanel
          footer={
            <>
              Sign in from the CLI, then host with <code>./bin/sparkler host &lt;file&gt;</code>.
            </>
          }
        />
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
