export interface D1Statement {
  bind(...values: Array<string | number>): D1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ success: boolean; results: T[] }>;
  run(): Promise<{ success: boolean }>;
}

export interface D1Database {
  prepare(query: string): D1Statement;
}

export interface Env {
  DB: D1Database;
}

export type PagesFunction = (context: {
  request: Request;
  env: Env;
}) => Response | Promise<Response>;

export interface Account {
  id: string;
  username: string;
}

const sessionCookie = 'ppuljit_session';
const sessionLifetimeSeconds = 60 * 60 * 24 * 30;
const passwordIterations = 100_000;

export const json = (body: unknown, status = 200, headers = new Headers()): Response => {
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers });
};

export function hasSameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashPassword(password: string, salt = crypto.getRandomValues(new Uint8Array(16))): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: passwordIterations, hash: 'SHA-256' },
    key,
    256,
  );
  return `pbkdf2-sha256$${passwordIterations}$${base64Url(salt)}$${base64Url(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [algorithm, iterations, encodedSalt, expected] = storedHash.split('$');
  if (
    algorithm !== 'pbkdf2-sha256' ||
    iterations !== String(passwordIterations) ||
    !encodedSalt ||
    !expected
  ) {
    return false;
  }

  const salt = new Uint8Array(16);
  salt.set(fromBase64Url(encodedSalt));
  const actualHash = await hashPassword(password, salt);
  const actual = fromBase64Url(actualHash.split('$')[3]);
  const expectedBytes = fromBase64Url(expected);
  if (actual.length !== expectedBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual[index] ^ expectedBytes[index];
  return difference === 0;
}

function sessionToken(request: Request): string | null {
  const cookie = request.headers.get('Cookie') ?? '';
  const value = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${sessionCookie}=`));
  const token = value?.slice(sessionCookie.length + 1);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

export async function authenticate(request: Request, env: Env): Promise<Account | null> {
  const token = sessionToken(request);
  if (!token) return null;
  const tokenHash = await sha256(token);
  return env.DB.prepare(
    `SELECT users.id, users.username
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
  )
    .bind(tokenHash, new Date().toISOString())
    .first<Account>();
}

export async function createSession(accountId: string, request: Request, env: Env): Promise<Headers> {
  const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = new Date(Date.now() + sessionLifetimeSeconds * 1000).toISOString();
  const result = await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
  )
    .bind(await sha256(token), accountId, expiresAt, new Date().toISOString())
    .run();
  if (!result.success) throw new Error('D1 did not save the session.');

  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  const headers = new Headers();
  headers.set(
    'Set-Cookie',
    `${sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionLifetimeSeconds}${secure}`,
  );
  return headers;
}

export function clearSessionCookie(request: Request): Headers {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  const headers = new Headers();
  headers.set('Set-Cookie', `${sessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
  return headers;
}

export async function deleteSession(request: Request, env: Env): Promise<void> {
  const token = sessionToken(request);
  if (!token) return;
  const result = await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
    .bind(await sha256(token))
    .run();
  if (!result.success) throw new Error('D1 did not delete the session.');
}
