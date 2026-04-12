import { useParams } from "react-router-dom";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import SplatViewer from "../components/SplatViewer.jsx";

export default function Viewer() {
  const { sceneId } = useParams();
  const data = useQuery(api.scenes.getScene, {
    sceneId: sceneId,
  });

  if (data === undefined) {
    return (
      <div className="page">
        <p>Loading…</p>
      </div>
    );
  }
  if (data === null) {
    return (
      <div className="page">
        <p>Scene not found or you do not have access.</p>
      </div>
    );
  }

  if (data.status !== "ready") {
    return (
      <div className="page">
        <h1>{data.title}</h1>
        <p className="muted">Status: {data.status}</p>
      </div>
    );
  }

  return (
    <div className="viewer-wrap">
      <div className="viewer-bar">
        <span style={{ flex: 1 }}>{data.filename || data.title}</span>
      </div>
      <SplatViewer
        sceneId={data._id}
        splatUrl={data.splatUrl}
        needsSignedUrl={data.needsSignedUrl}
        filename={data.filename}
        defaultView={data.defaultView}
        canEdit={data.isOwner}
      />
    </div>
  );
}
