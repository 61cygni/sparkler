import { defineApp } from "convex/server";
import selfHosting from "@convex-dev/static-hosting/convex.config";

const app = defineApp();

app.use(selfHosting);

export default app;
