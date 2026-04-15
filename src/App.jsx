import { Link, Route, Routes, useLocation } from "react-router-dom";
import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/clerk-react";
import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import Home from "./pages/Home.jsx";
import Gallery from "./pages/Gallery.jsx";
import About from "./pages/About.jsx";
import Viewer from "./pages/Viewer.jsx";
import Embed from "./pages/Embed.jsx";
import CliLogin from "./pages/CliLogin.jsx";
import CliLogout from "./pages/CliLogout.jsx";
import AdminAccess from "./pages/AdminAccess.jsx";

const clerkEnabled = Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);

function AuthChrome() {
  if (!clerkEnabled) {
    return (
      <span className="muted" style={{ fontSize: "0.85rem" }}>
        Dev mode: set <code>SPARKLER_DEMO_OWNER_SUBJECT</code> in Convex to upload
      </span>
    );
  }
  return (
    <>
      <SignedOut>
        <SignInButton mode="modal">
          <button type="button">Sign in</button>
        </SignInButton>
      </SignedOut>
      <SignedIn>
        <UserButton afterSignOutUrl="/" />
      </SignedIn>
    </>
  );
}

export default function App() {
  const { pathname } = useLocation();
  const accountStatus = useQuery(api.users.getMyAccountStatus);
  const chromeless =
    pathname.startsWith("/s/") ||
    pathname.startsWith("/embed/") ||
    pathname.startsWith("/cli-login") ||
    pathname.startsWith("/cli-logout");

  return (
    <>
      {!chromeless ? (
        <header
          style={{
            borderBottom: "1px solid #2d323c",
            padding: "0.75rem 1.5rem",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "1rem",
          }}
        >
          <nav style={{ display: "flex", alignItems: "center", gap: "1.25rem" }}>
            <Link to="/" style={{ fontWeight: 700 }}>
              Sparkler
            </Link>
            <Link to="/gallery">Public</Link>
            <Link to="/about">About</Link>
            {accountStatus?.isAdmin ? <Link to="/admin/access">Admin</Link> : null}
          </nav>
          <AuthChrome />
        </header>
      ) : null}
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/gallery" element={<Gallery />} />
        <Route path="/about" element={<About />} />
        <Route path="/s/:sceneId" element={<Viewer />} />
        <Route path="/embed/:sceneId" element={<Embed />} />
        <Route path="/cli-login" element={<CliLogin />} />
        <Route path="/cli-logout" element={<CliLogout />} />
        <Route path="/admin/access" element={<AdminAccess />} />
      </Routes>
    </>
  );
}
