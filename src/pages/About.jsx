export default function About() {
  return (
    <div className="page">
      <section className="terminal-panel" aria-label="About Sparkler">
        <div className="terminal-panel__header">
          <span>about sparkler</span>
        </div>
        <div className="terminal-panel__prose">
          <p>
            Sparkler is a platform for hosting Gaussian splats. It is intended to be 
            very simple to use, yet supports LoD, streaming, mobile, WebXR, and embedding.
          </p>
        </div>
      </section>
    </div>
  );
}
