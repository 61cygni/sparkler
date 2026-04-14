export const INSTALL_SNIPPET = [
  "curl -fsSL https://raw.githubusercontent.com/61cygni/sparkler/main/public/setup.sh -o setup.sh",
  "bash setup.sh",
  "./bin/sparkler login",
  "./bin/sparkler host ./myscan.spz",
];

export default function CliQuickstartPanel({
  ariaLabel = "CLI quickstart",
  title = "sparkler quickstart",
  footer = null,
}) {
  return (
    <section className="terminal-panel" aria-label={ariaLabel}>
      <div className="terminal-panel__header">
        <span>{title}</span>
      </div>
      <pre className="terminal-panel__body">
        {INSTALL_SNIPPET.map((line) => `$ ${line}`).join("\n")}
      </pre>
      {footer ? <p className="terminal-panel__footer">{footer}</p> : null}
    </section>
  );
}
