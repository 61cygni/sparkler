import CliQuickstartPanel from "../components/CliQuickstartPanel.jsx";

export default function About() {
  return (
    <div className="page">
      <section className="terminal-panel" aria-label="About Sparkler">
        <div className="terminal-panel__header">
          <span>about sparkler</span>
        </div>
        <div className="terminal-panel__prose">
          <p>
            Sparkler is a platform for hosting Gaussian splats based on the
            Sparkjs splat rendering library. It is intended to be very simple to
            use, yet supports LoD, streaming, mobile, WebXR, sharing, and embedding.
          </p>
          <p>
            The primary interface for uploading and hosting is the sparkler CLI. It can take a .ply or .spz,
            build the LoD tree, convert it to a .rad file which allows for inremental loading. And uploads 
            the file. From the CLI you can set permissions, starting positions, viewing paramaters, background
            music and more. 
          </p>
          <p>
            All hosted scenes are infinite persistent, sharable and support WebXR and mobile. 
          </p>
          <p>To get started, simply install the CLI and upload a scene using the quickstart below.</p>
        </div>
      </section>
      <CliQuickstartPanel
        ariaLabel="Sparkler CLI quickstart"
        title="sparkler quickstart"
      />
    </div>
  );
}
