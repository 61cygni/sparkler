import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ClerkProvider, useAuth } from "@clerk/clerk-react";
import { getConvexUrl } from "@convex-dev/static-hosting";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import App from "./App.jsx";
import "./index.css";

const hostedOnConvexSite =
  typeof window !== "undefined" && window.location.hostname.endsWith(".convex.site");
const convexUrl = import.meta.env.VITE_CONVEX_URL ?? (hostedOnConvexSite ? getConvexUrl() : "");
if (!convexUrl) {
  throw new Error("Set VITE_CONVEX_URL in .env.local (from npx convex dev).");
}

const convex = new ConvexReactClient(convexUrl);
const clerkPub = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

function Root() {
  if (clerkPub) {
    return (
      <ClerkProvider publishableKey={clerkPub}>
        <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ConvexProviderWithClerk>
      </ClerkProvider>
    );
  }
  return (
    <ConvexProvider client={convex}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ConvexProvider>
  );
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
