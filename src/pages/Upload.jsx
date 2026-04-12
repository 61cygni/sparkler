import { useState } from "react";
import { Link } from "react-router-dom";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export default function Upload() {
  const accountStatus = useQuery(api.users.getMyAccountStatus);
  const createScene = useMutation(api.scenes.createScene);
  const finalizeScene = useMutation(api.scenes.finalizeScene);
  const markFailed = useMutation(api.scenes.markSceneFailed);
  const presignUpload = useAction(api.tigris.presignUpload);

  const [title, setTitle] = useState("");
  const [visibility, setVisibility] = useState("unlisted");
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [doneId, setDoneId] = useState(null);
  const canUpload = accountStatus === undefined || accountStatus?.isApproved === true;

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setDoneId(null);
    if (accountStatus?.approvalStatus === "pending") {
      setError("Your account is pending approval.");
      return;
    }
    if (accountStatus?.approvalStatus === "rejected") {
      setError("Your account was rejected.");
      return;
    }
    if (!file) {
      setError("Choose a file.");
      return;
    }
    setStatus("Creating scene…");
    try {
      const { sceneId } = await createScene({
        filename: file.name,
        title: title.trim() || undefined,
        visibility,
        contentType: file.type || undefined,
        byteSize: file.size,
      });
      setStatus("Uploading to storage…");
      const { url, headers } = await presignUpload({
        sceneId,
        contentType: file.type || "application/octet-stream",
        byteSize: file.size,
      });
      const putRes = await fetch(url, {
        method: "PUT",
        headers,
        body: file,
      });
      if (!putRes.ok) {
        await markFailed({ sceneId });
        throw new Error(`Upload failed: ${putRes.status} ${putRes.statusText}`);
      }
      setStatus("Finalizing…");
      await finalizeScene({
        sceneId,
        byteSize: file.size,
        contentType: file.type || undefined,
      });
      setStatus("Done.");
      setDoneId(sceneId);
    } catch (err) {
      setStatus("");
      setError(err.message || String(err));
    }
  }

  return (
    <div className="page">
      <h1 style={{ marginTop: 0 }}>Upload</h1>
      {accountStatus?.approvalStatus === "pending" ? (
        <p className="muted">
          Your account is pending approval. An admin must approve you before uploads are enabled.
        </p>
      ) : null}
      {accountStatus?.approvalStatus === "rejected" ? (
        <p className="muted">
          Your account was rejected. Contact an admin if you need access restored.
        </p>
      ) : null}
      <form onSubmit={onSubmit} style={{ maxWidth: 420 }}>
        <label style={{ display: "block", marginBottom: "0.75rem" }}>
          <span className="muted">Title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="My scan"
            disabled={!canUpload}
            style={{ display: "block", width: "100%", marginTop: 4, padding: "0.5rem" }}
          />
        </label>
        <label style={{ display: "block", marginBottom: "0.75rem" }}>
          <span className="muted">Visibility</span>
          <select
            value={visibility}
            onChange={(e) => setVisibility(e.target.value)}
            disabled={!canUpload}
            style={{ display: "block", width: "100%", marginTop: 4, padding: "0.5rem" }}
          >
            <option value="public">Public (listed on home)</option>
            <option value="unlisted">Unlisted (link only)</option>
            <option value="private">Private (owner only)</option>
          </select>
        </label>
        <label style={{ display: "block", marginBottom: "0.75rem" }}>
          <span className="muted">Splat file</span>
          <input
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={!canUpload}
            style={{ display: "block", marginTop: 4 }}
          />
        </label>
        <button type="submit" disabled={!canUpload} style={{ padding: "0.5rem 1rem" }}>
          Upload
        </button>
      </form>
      {status ? <p style={{ marginTop: "1rem" }}>{status}</p> : null}
      {error ? (
        <p style={{ marginTop: "1rem", color: "#f5a8a8" }}>
          {error}
        </p>
      ) : null}
      {doneId ? (
        <p style={{ marginTop: "1rem" }}>
          <Link to={`/s/${doneId}`}>Open viewer →</Link>
        </p>
      ) : null}
      <p className="muted" style={{ marginTop: "2rem", fontSize: "0.9rem" }}>
        Requires Tigris env vars on Convex and auth (Clerk or{" "}
        <code>SPARKLER_DEMO_OWNER_SUBJECT</code>).
      </p>
    </div>
  );
}
