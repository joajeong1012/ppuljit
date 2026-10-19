import {
  authenticate,
  clearSessionCookie,
  createSession,
  deleteSession,
  hashPassword,
  hasSameOrigin,
  json,
  verifyPassword,
  type Env,
  type PagesFunction,
} from '../_utils/auth';

interface AuthBody {
  action: 'register' | 'login' | 'logout';
  username?: string;
  password?: string;
}

interface StoredAccount {
  id: string;
  username: string;
  passwordHash: string;
}

function isAuthBody(value: unknown): value is AuthBody {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    (body.action === 'register' || body.action === 'login' || body.action === 'logout') &&
    (body.username === undefined || typeof body.username === 'string') &&
    (body.password === undefined || typeof body.password === 'string')
  );
}

function credentials(body: AuthBody): { username: string; password: string } | null {
  if (typeof body.username !== 'string' || typeof body.password !== 'string') return null;
  const username = body.username.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(username) || body.password.length < 8 || body.password.length > 128) {
    return null;
  }
  return { username, password: body.password };
}

async function register(
  request: Request,
  env: Env,
  username: string,
  password: string,
): Promise<Response> {
  const accountId = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  try {
    const result = await env.DB.prepare(
      'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind(accountId, username, passwordHash, new Date().toISOString())
      .run();
    if (!result.success) throw new Error('D1 did not create the account.');
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      return json({ error: '이미 사용 중인 아이디입니다.' }, 409);
    }
    throw error;
  }

  const headers = await createSession(accountId, request, env);
  return json({ username }, 201, headers);
}

async function login(
  request: Request,
  env: Env,
  username: string,
  password: string,
): Promise<Response> {
  const account = await env.DB.prepare(
    'SELECT id, username, password_hash AS passwordHash FROM users WHERE username = ?',
  )
    .bind(username)
    .first<StoredAccount>();
  if (!account || !(await verifyPassword(password, account.passwordHash))) {
    return json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' }, 401);
  }

  const headers = await createSession(account.id, request, env);
  return json({ username: account.username }, 200, headers);
}

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const account = await authenticate(request, env);
    return account ? json({ username: account.username }) : json({ error: '로그인이 필요합니다.' }, 401);
  } catch (error) {
    console.error('로그인 상태를 확인하지 못했습니다.', error);
    return json({ error: '로그인 상태를 확인하지 못했습니다.' }, 500);
  }
};

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  if (!hasSameOrigin(request)) return json({ error: '허용되지 않은 요청입니다.' }, 403);
  if (!request.headers.get('Content-Type')?.includes('application/json')) {
    return json({ error: '요청 형식은 JSON이어야 합니다.' }, 400);
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 8_192) {
      return json({ error: '요청 본문이 너무 큽니다.' }, 413);
    }
    body = JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: '요청 형식이 올바르지 않습니다.' }, 400);
    console.error('계정 요청 본문을 읽지 못했습니다.', error);
    return json({ error: '계정 요청을 처리하지 못했습니다.' }, 500);
  }
  if (!isAuthBody(body)) return json({ error: '요청 형식이 올바르지 않습니다.' }, 400);
  const input = body.action === 'logout' ? null : credentials(body);
  if (body.action !== 'logout' && !input) {
    return json({ error: '아이디는 영문 소문자·숫자·밑줄 3~20자, 비밀번호는 8~128자로 입력하세요.' }, 400);
  }

  try {
    if (body.action === 'logout') {
      await deleteSession(request, env);
      return json({ success: true }, 200, clearSessionCookie(request));
    }
    if (!input) return json({ error: '계정 정보를 확인하세요.' }, 400);
    return body.action === 'register'
      ? await register(request, env, input.username, input.password)
      : await login(request, env, input.username, input.password);
  } catch (error) {
    console.error('계정 요청을 처리하지 못했습니다.', error);
    return json({ error: '계정 요청을 처리하지 못했습니다.' }, 500);
  }
};
