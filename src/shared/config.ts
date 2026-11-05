// Central configuration: URLs, demo clients, demo users, scopes and token lifetimes.

export const PORT = Number(process.env.PORT ?? 3000);

/** Public base URL of the whole app. Everything else is derived from it. */
export const APP_ORIGIN = (
  process.env.APP_ORIGIN ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : `http://localhost:${PORT}`)
).replace(/\/+$/, "");

export const IS_HTTPS = APP_ORIGIN.startsWith("https://");

/** OAuth issuer identifier. Discovery lives at `${ISSUER}/.well-known/openid-configuration`. */
export const ISSUER = `${APP_ORIGIN}/auth`;

/** The audience the Resource API expects in access tokens. */
export const API_AUDIENCE = `${APP_ORIGIN}/api`;

export const TTL = {
  accessToken: 60, // short on purpose, so the refresh flow can be demoed
  idToken: 300,
  refreshToken: 3600,
  authCode: 60,
  authRequest: 600,
  session: 7200,
  events: 7200,
} as const;

export type GrantType = "authorization_code" | "refresh_token" | "client_credentials";

export interface OAuthClient {
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris: string[];
  grant_types: GrantType[];
  scopes: string[];
}

export const CLIENTS: OAuthClient[] = [
  {
    client_id: "demo-web-app",
    client_secret: "web-secret-123",
    name: "Demo Web App",
    redirect_uris: [`${APP_ORIGIN}/client/callback`],
    grant_types: ["authorization_code", "refresh_token"],
    scopes: ["openid", "profile", "email", "offline_access", "api:read"],
  },
  {
    client_id: "reports-service",
    client_secret: "svc-secret-456",
    name: "Reports Service (machine-to-machine)",
    redirect_uris: [],
    grant_types: ["client_credentials"],
    scopes: ["reports:read"],
  },
];

export const SCOPE_DESCRIPTIONS: Record<string, string> = {
  openid: "Sign you in (OpenID Connect): issue an ID token",
  profile: "See your name and username",
  email: "See your email address",
  offline_access: "Stay connected when you're away (refresh token)",
  "api:read": "Read your data from the Demo Resource API",
  "reports:read": "Read company reports",
};

export interface DemoUser {
  sub: string;
  username: string;
  password: string;
  name: string;
  email: string;
}

export const USERS: DemoUser[] = [
  { sub: "user-alice-001", username: "alice", password: "alice123", name: "Alice Anderson", email: "alice@example.com" },
  { sub: "user-bob-002", username: "bob", password: "bob123", name: "Bob Brown", email: "bob@example.com" },
];

export const findClient = (id: string | undefined) => CLIENTS.find((c) => c.client_id === id);
export const findUser = (username: string | undefined) => USERS.find((u) => u.username === username);
export const findUserBySub = (sub: string | undefined) => USERS.find((u) => u.sub === sub);

/** The client app's own registration, used by /client. */
export const WEB_CLIENT = CLIENTS[0];
export const SERVICE_CLIENT = CLIENTS[1];
