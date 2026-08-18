export * from "./passwords";
export * from "./session";

import { getCurrentSession as readSessionFromCookie, type SessionPayload } from "./session";
import { openDatabase } from "../db";
import { UserRepository } from "../db/users";

/**
 * Node-runtime session accessor for route handlers. Unlike the edge-safe
 * `./session` module, this also requires the session subject to exist in
 * `portal_users`. A signature-valid token whose user is gone (deleted user,
 * or a session minted by another Portal instance that shares the same host
 * and dev JWT secret) must not authorize anything — it would otherwise
 * poison conversation scope rows with a runtime-unmatchable user id.
 * The local export shadows the star export above; middleware keeps using
 * `readSessionFromRequest` from `./session` directly.
 */
export async function getCurrentSession(): Promise<SessionPayload | null> {
  const payload = await readSessionFromCookie();
  if (!payload) return null;
  const user = new UserRepository(openDatabase()).getById(payload.sub);
  return user ? payload : null;
}
