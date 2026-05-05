import { Router, Request, Response } from 'express';
import { supabase, supabaseAuth } from '../config/supabase';

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
// for this email" without that probe leaking through the public sign-in
// flow. Same need on signup so EMAIL_TAKEN can win over PASSWORD_FORMAT
// when both are wrong.
//
// GoTrue's admin /users endpoint does NOT honour an `?email=` filter (it
// silently ignores unknown query params and returns the first page of all
// users), so we fetch pages via the SDK and scan client-side. Service-role
// authenticated, no email side effect.
//
// Fails closed: any error returns null and the caller falls back to whatever
// code Supabase returned originally.
//
// TODO: replace with a Postgres RPC ('SELECT 1 FROM auth.users WHERE
// email = $1') once the user base outgrows the scan window — current cap
// (50 pages × 1000 = 50k users) is comfortable for early-stage but not
// production-scale.
async function emailExists(email: string): Promise<boolean | null> {
  const target = email.trim().toLowerCase();
  if (target.length === 0) return false;
  try {
    const PER_PAGE = 1000;
    const MAX_PAGES = 50;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, error } = await supabase.auth.admin.listUsers({
        page,
        perPage: PER_PAGE,
      });
      if (error || !data) return null;
      const found = data.users.some(
        (u) => typeof u.email === 'string' && u.email.toLowerCase() === target,
      );
      if (found) return true;
      if (data.users.length < PER_PAGE) return false;
    }
    return null;
  } catch {
    return null;
  }
}

// Server-side password policy. Mirrors haru_FE/src/utils/validators.ts so a
// caller bypassing the FE (direct API call) can't slip a weak password past
// what Supabase's default rules would otherwise allow.
const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*\d).{8,}$/;

// 이메일+비밀번호 회원가입
router.post('/signup', async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }

  if (!PASSWORD_RE.test(password)) {
    // EMAIL_TAKEN still has to win over PASSWORD_FORMAT (the email is the
    // gating field, see emailExists() docstring) — probe before responding.
    let code: AuthErrorCode = 'PASSWORD_FORMAT';
    const exists = await emailExists(email);
    if (exists === true) code = 'EMAIL_TAKEN';
    res.status(400).json({
      error: 'password must be at least 8 characters and include a letter and a number',
      code,
    });
    return;
  }

  const { data, error } = await supabaseAuth.auth.signUp({
    email,
    password,
  });

  if (error) {
    let code = mapSignupError(error.message);
    // Supabase rejects weak passwords *before* checking if the email is
    // already taken, so a user typing both a known-existing email AND a
    // bad password sees `PASSWORD_FORMAT` even though the real blocker is
    // the email. Probe existence here so the FE can prioritise the
    // email-side message — the user has to fix the email regardless.
    if (code === 'PASSWORD_FORMAT') {
      const exists = await emailExists(email);
      if (exists === true) code = 'EMAIL_TAKEN';
    }
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
