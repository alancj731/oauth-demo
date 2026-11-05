// The Client App's own server-side session (what a real "backend for frontend"
// would keep). Stored in the shared store, keyed by the client_sid cookie.

import type { Request, Response } from "express";
import { IS_HTTPS, TTL } from "../shared/config.js";
import type { HttpRequestRecord, TraceEvent } from "../shared/inspector.js";
import { kv } from "../shared/store.js";
import { randomId } from "../shared/util.js";

export interface Check { name: string; ok: boolean; detail: string }

export interface Tokens {
  access_token: string;
  token_type: string;
  expires_at: number; // epoch ms
  scope: string;
  id_token?: string;
  refresh_token?: string;
}

export interface ClientSession {
  pkce?: { verifier: string; challenge: string; state: string; nonce: string; scope: string; variant?: string };
  authUrl?: string;
  callback?: { params: Record<string, string>; stateOk: boolean; issOk: boolean; error?: string };
  tokenPreview?: { request: HttpRequestRecord };
  exchange?: TraceEvent;
  wrongVerifier?: TraceEvent;
  usedCode?: string;
  tokens?: Tokens;
  idCheck?: { checks: Check[]; jwks: TraceEvent };
  userinfo?: TraceEvent;
  api?: TraceEvent;
  refresh?: { calls: { label: string; event: TraceEvent }[]; oldRefreshToken?: string };
  m2m?: { token?: TraceEvent; access_token?: string; reports?: TraceEvent; profile?: TraceEvent };
  failures?: Record<string, TraceEvent>;
}

const COOKIE = "client_sid";

export async function loadSession(req: Request, res: Response): Promise<{ id: string; s: ClientSession }> {
  let id = req.cookies?.[COOKIE] as string | undefined;
  const s = id ? await kv.get<ClientSession>(`client_session:${id}`) : null;
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    id = randomId(16);
    res.cookie(COOKIE, id, { httpOnly: true, sameSite: "lax", secure: IS_HTTPS, path: "/client", maxAge: TTL.session * 1000 });
  }
  return { id, s: s ?? {} };
}

export const saveSession = (id: string, s: ClientSession) => kv.set(`client_session:${id}`, s, TTL.session);
