import { useLocation, useParams } from "react-router-dom";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import SplatViewer from "../components/SplatViewer.jsx";

export default function Viewer() {
  const { sceneId } = useParams();
  const location = useLocation();
  const data = useQuery(api.scenes.getScene, {
    sceneId: sceneId,
  });
  const isPassiveView = new URLSearchParams(location.search).get("mode") === "view";

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
      <SplatViewer
        sceneId={data._id}
        splatUrl={data.splatUrl}
        needsSignedUrl={data.needsSignedUrl}
        filename={data.filename}
        title={data.title}
        viewerMode={isPassiveView ? "view" : data.isOwner ? "owner" : "normal"}
        defaultView={data.defaultView}
        sceneAudio={data.audio}
      />
    </div>
  );
}
