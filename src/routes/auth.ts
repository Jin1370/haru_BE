import { Router, Request, Response } from 'express';
import { supabaseAuth } from '../config/supabase';
import { env } from '../config/env';

const router = Router();

// Distinguishable error codes consumed by FE for inline-error UX. The
// `error` field stays human-readable for backward compat; FE prefers `code`
// when present and falls back to mapping `error` only as a last resort.
//
//   EMAIL_NOT_REGISTERED  login: address has no account
//   WRONG_PASSWORD        login: address exists but password mismatch
//   EMAIL_TAKEN           signup: address already has an account
//   PASSWORD_FORMAT       signup: password fails server-side rules
//   EMAIL_NOT_CONFIRMED   login: address exists but email confirmation pending
type AuthErrorCode =
  | 'EMAIL_NOT_REGISTERED'
  | 'WRONG_PASSWORD'
  | 'EMAIL_TAKEN'
  | 'PASSWORD_FORMAT'
  | 'EMAIL_NOT_CONFIRMED';

// Supabase Auth surfaces these via `error.message`. We map common substrings
// to our discriminated codes; unknown errors flow through with no `code` so
// the FE shows a generic Alert instead of misattributing the cause.
function mapLoginError(message: string | undefined): AuthErrorCode | null {
  if (!message) return null;
  const m = message.toLowerCase();
  if (m.includes('invalid login credentials')) return 'WRONG_PASSWORD';
  if (m.includes('email not confirmed')) return 'EMAIL_NOT_CONFIRMED';
  if (m.includes('user not found')) return 'EMAIL_NOT_REGISTERED';
  return null;
}

function mapSignupError(message: string | undefined): AuthErrorCode | null {
  if (!message) return null;
  const m = message.toLowerCase();
  if (
    m.includes('user already registered') ||
    m.includes('already been registered') ||
    m.includes('already registered')
  ) {
    return 'EMAIL_TAKEN';
  }
  if (
    m.includes('password should be') ||
    m.includes('weak password') ||
    m.includes('password is too')
  ) {
    return 'PASSWORD_FORMAT';
  }
  return null;
}

// Supabase deliberately collapses "wrong password" and "no account" into a
// single 400/Invalid-login-credentials response so attackers can't enumerate
// addresses. For our login form we want to tell the *real* user "no account
// for this email" without that probe leaking through the public sign-in flow.
//
// We use the admin REST endpoint /auth/v1/admin/users?email=... which:
//   • is auth'd by the service role key (never exposed beyond the BE),
//   • does not send any email,
//   • returns a paged list whose `users` array is empty when no match.
//
// Fails closed: any network or auth error returns null, and the caller
// falls back to the original WRONG_PASSWORD code.
async function emailExists(email: string): Promise<boolean | null> {
  try {
    const url = new URL(`${env.supabase.url}/auth/v1/admin/users`);
    url.searchParams.set('email', email);
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${env.supabase.serviceRoleKey}`,
        apikey: env.supabase.serviceRoleKey,
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { users?: Array<{ id?: string }> };
    return Array.isArray(data.users) && data.users.length > 0;
  } catch {
    return null;
  }
}

// 이메일+비밀번호 회원가입
router.post('/signup', async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }

  const { data, error } = await supabaseAuth.auth.signUp({
    email,
    password,
  });

  if (error) {
    const code = mapSignupError(error.message);
    res.status(400).json({ error: error.message, ...(code ? { code } : {}) });
    return;
  }

  res.status(201).json({
    access_token: data.session?.access_token,
    refresh_token: data.session?.refresh_token,
    user: {
      id: data.user?.id,
      email: data.user?.email,
    },
  });
});

// 이메일+비밀번호 로그인
router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }

  const { data, error } = await supabaseAuth.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    let code = mapLoginError(error.message);
    // Distinguish EMAIL_NOT_REGISTERED from WRONG_PASSWORD using the admin
    // existence probe — see emailExists() docstring for the rationale.
    if (code === 'WRONG_PASSWORD') {
      const exists = await emailExists(email);
      if (exists === false) code = 'EMAIL_NOT_REGISTERED';
    }
    res.status(401).json({ error: error.message, ...(code ? { code } : {}) });
    return;
  }

  res.json({
    access_token: data.session?.access_token,
    refresh_token: data.session?.refresh_token,
    user: {
      id: data.user?.id,
      email: data.user?.email,
    },
  });
});

// Google OAuth 토큰으로 Supabase 세션 생성
router.post('/google', async (req: Request, res: Response) => {
  const { id_token } = req.body;

  if (!id_token) {
    res.status(400).json({ error: 'id_token is required' });
    return;
  }

  const { data, error } = await supabaseAuth.auth.signInWithIdToken({
    provider: 'google',
    token: id_token,
  });

  if (error) {
    res.status(401).json({ error: error.message });
    return;
  }

  res.json({
    access_token: data.session?.access_token,
    refresh_token: data.session?.refresh_token,
    user: {
      id: data.user?.id,
      email: data.user?.email,
    },
  });
});

// 토큰 갱신
router.post('/refresh', async (req: Request, res: Response) => {
  const { refresh_token } = req.body;

  if (!refresh_token) {
    res.status(400).json({ error: 'refresh_token is required' });
    return;
  }

  const { data, error } = await supabaseAuth.auth.refreshSession({ refresh_token });

  if (error) {
    res.status(401).json({ error: error.message });
    return;
  }

  res.json({
    access_token: data.session?.access_token,
    refresh_token: data.session?.refresh_token,
  });
});

export default router;
