// Builds the single Express app that hosts all four parties.
// Vercel picks this file up automatically (zero-config Express) via the default export.
// Locally, src/dev.ts imports it and calls listen().

import cookieParser from "cookie-parser";
import express from "express";
import { authServer } from "./auth-server/index.js";
import { clientApp } from "./client-app/index.js";
import { homeView } from "./client-app/views.js";
import { inspector } from "./inspector/index.js";
import { resourceServer } from "./resource-server/index.js";
import { labSession } from "./shared/inspector.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

// On Vercel, files in /public are served by the CDN; this is for local dev.
app.use(express.static("public", { maxAge: "5m" }));

app.use(cookieParser());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(labSession);

app.get("/", (_req, res) => res.send(homeView({}, "home")));
app.use("/client", clientApp);
app.use("/auth", authServer);
app.use("/api", resourceServer);
app.use("/inspector", inspector);

app.use((req, res) => res.status(404).type("text/plain").send(`Not found: ${req.method} ${req.path}`));
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  if (!res.headersSent) res.status(500).type("text/plain").send(`Internal error: ${err.message}`);
});

export default app;
