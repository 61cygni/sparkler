import { useClerk } from "@clerk/clerk-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

const clerkPub = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

function doneUrl() {
  if (typeof window === "undefined") {
    return "/cli-logout?signed_out=1";
  }
  return `${window.location.origin}/cli-logout?signed_out=1`;
}

function CliLogoutInner() {
  const { signOut } = useClerk();
  const [error, setError] = useState("");
  const signedOut = useMemo(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return new URLSearchParams(window.location.search).get("signed_out") === "1";
  }, []);

  useEffect(() => {
    if (signedOut) {
      return;
    }
    void signOut({ redirectUrl: doneUrl() }).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [signOut, signedOut]);

  return (
    <main style={{ padding: "2rem", maxWidth: 520 }}>
      <h1 style={{ marginTop: 0 }}>Sparkler CLI logout</h1>
      {signedOut ? (
        <p className="muted">Your browser Clerk session has been signed out.</p>
      ) : error ? (
        <p style={{ color: "#f87171", whiteSpace: "pre-wrap" }} role="alert">
          {error}
        </p>
      ) : (
        <p className="muted">Signing you out of Clerk in this browser…</p>
      )}
      <p style={{ marginTop: "2rem" }}>
        <Link to="/">Return home</Link>
      </p>
    </main>
  );
}

export default function CliLogout() {
  if (!clerkPub) {
    return (
      <main style={{ padding: "2rem", maxWidth: 520 }}>
        <h1 style={{ marginTop: 0 }}>CLI logout</h1>
        <p className="muted">
          Clerk is not configured for this app build, so only local CLI credentials can be removed.
        </p>
        <p style={{ marginTop: "2rem" }}>
          <Link to="/">Return home</Link>
        </p>
      </main>
    );
  }
  return <CliLogoutInner />;
}
