import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { env } from '../config/env';
import { supabase, supabaseAuth } from '../config/supabase';
import { authMiddleware } from '../middleware/auth';
import { deleteVoiceClone } from '../services/elevenlabs';
import { AuthRequest } from '../types';

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
  if (m.includes('email not confirmed')) return 'EMAIL_NOT_CONFIRMED';
  return null;
}

// Supabase deliberately collapses "wrong password" and "no account" into a
// single 400/Invalid-login-credentials response so attackers can't enumerate
// addresses. For our login form we want to tell the *real* user "no account
// for this email" without that probe leaking through the public sign-in
// flow. Same need on signup so EMAIL_TAKEN can win over PASSWORD_FORMAT
// when both are wrong, and so an *already-confirmed* user retrying signup
// is told "email taken" instead of getting the misleading "check your
// inbox" toast (Supabase's signUp() returns a fake/no-session payload for
// already-registered users to prevent enumeration, but never actually
// sends a new mail when the existing row is confirmed).
//
// GoTrue's admin /users endpoint does NOT honour an `?email=` filter (it
// silently ignores unknown query params and returns the first page of all
// users), so we fetch pages via the SDK and scan client-side. Service-role
// authenticated, no email side effect.
//
// Fails closed: any error returns null and the caller falls back to whatever
// code Supabase returned originally.
//
// TODO: replace with a Postgres RPC ('SELECT id, email_confirmed_at FROM
// auth.users WHERE email = $1') once the user base outgrows the scan window
// — current cap (50 pages × 1000 = 50k users) is comfortable for early-stage
// but not production-scale.
type EmailIdentity = { exists: boolean; confirmed: boolean };

async function findEmailIdentity(email: string): Promise<EmailIdentity | null> {
  const target = email.trim().toLowerCase();
  if (target.length === 0) return { exists: false, confirmed: false };
  try {
    const PER_PAGE = 1000;
    const MAX_PAGES = 50;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, error } = await supabase.auth.admin.listUsers({
        page,
        perPage: PER_PAGE,
      });
      if (error || !data) return null;
      const found = data.users.find(
        (u) => typeof u.email === 'string' && u.email.toLowerCase() === target,
      );
      if (found) {
        return { exists: true, confirmed: Boolean(found.email_confirmed_at) };
      }
      if (data.users.length < PER_PAGE) return { exists: false, confirmed: false };
    }
    return null;
  } catch {
    return null;
  }
}

async function emailExists(email: string): Promise<boolean | null> {
  const identity = await findEmailIdentity(email);
  if (identity === null) return null;
  return identity.exists;
}

// Server-side password policy. Mirrors haru_FE/src/utils/validators.ts so a
// caller bypassing the FE (direct API call) can't slip a weak password past
// what Supabase's default rules would otherwise allow.
const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*\d).{8,}$/;

// message-moderation-v1 follow-up: 로그인 시점 frozen 차단.
// Supabase 인증은 통과했지만 profiles.frozen_at 가 set 된 사용자에게는
// 토큰을 발급하지 않고 403 account_frozen 응답. FE 글로벌 핸들러가 모달 1회
// 노출 + 자동 로그아웃 흐름으로 통합. 가해자가 자기 상태를 다음 mutating 호출
// 까지 모르고 화면을 돌아다니는 UX 회귀를 차단한다 (2026-05-18 dev 환경 표면화).
// signup 은 신규 가입이라 freeze 불가 → 체크 생략.
async function isAccountFrozen(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('profiles')
    .select('frozen_at')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    // profile 조회 실패는 frozen 판정 불가 → 보수적으로 통과 (login 차단이
    // 인프라 장애로 모든 사용자에게 적용되는 회귀 회피). 실패 로그만 가시화.
    console.error('[auth.frozen_check_failed]', { user_id: userId, error: error.message });
    return false;
  }
  return Boolean(data?.frozen_at);
}

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
    options: {
      emailRedirectTo: env.auth.emailConfirmRedirectUrl,
    },
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

  // When Supabase's "Confirm email" toggle is ON, signUp returns a user but
  // no session — the FE must show a "check your inbox" state and block
  // login until the user clicks the confirmation link. The presence of
  // session decides this without the FE having to introspect Supabase
  // config.
  //
  // Caveat: Supabase obfuscates "email already registered" by returning the
  // SAME shape (fake user, no session) for users that *already* exist, to
  // prevent enumeration. For already-confirmed users no confirmation mail
  // is actually sent, so the FE's "check your inbox" toast would lie. Probe
  // here and upgrade the response to EMAIL_TAKEN when the address is
  // already confirmed; unconfirmed accounts still flow through the
  // confirmation path because Supabase does resend the mail in that case.
  if (!data.session) {
    const identity = await findEmailIdentity(email);
    if (identity?.exists && identity.confirmed) {
      res.status(400).json({ error: 'email already registered', code: 'EMAIL_TAKEN' });
      return;
    }
    res.status(201).json({
      needs_email_confirmation: true,
      user: {
        id: data.user?.id,
        email: data.user?.email,
      },
    });
    return;
  }

  res.status(201).json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
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

  if (data.user && (await isAccountFrozen(data.user.id))) {
    res.status(403).json({ error: 'Account frozen', code: 'account_frozen' });
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

  if (data.user && (await isAccountFrozen(data.user.id))) {
    res.status(403).json({ error: 'Account frozen', code: 'account_frozen' });
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

// Apple Sign In 토큰으로 Supabase 세션 생성 (App Store Guideline 4.8 — Google 로그인
// 제공 시 Sign in with Apple 동등 제공 필수). /google 핸들러를 그대로 미러 — Supabase
// signInWithIdToken 이 provider 만 'apple' 로 바뀌면 토큰 서명 검증·유저 생성/조회·세션
// 발급을 동일하게 처리한다. nonce 는 native (expo-apple-authentication) 흐름에서 생략 가능
// (Supabase Apple provider 가 Authorized Client IDs 로 aud=bundleId 를 검증).
router.post('/apple', async (req: Request, res: Response) => {
  const { id_token } = req.body;

  if (!id_token) {
    res.status(400).json({ error: 'id_token is required' });
    return;
  }

  const { data, error } = await supabaseAuth.auth.signInWithIdToken({
    provider: 'apple',
    token: id_token,
  });

  if (error) {
    res.status(401).json({ error: error.message });
    return;
  }

  if (data.user && (await isAccountFrozen(data.user.id))) {
    res.status(403).json({ error: 'Account frozen', code: 'account_frozen' });
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

// 비밀번호 변경 — 현재 비밀번호 검증 후 갱신.
//   WRONG_CURRENT_PASSWORD  현재 비밀번호 미스매치 (또는 OAuth 가입자라 비밀번호 자체가 없음)
//   PASSWORD_FORMAT         새 비밀번호가 서버 정책 위반
//   SAME_PASSWORD           새 비밀번호가 현재와 동일
//
// 검증 단계는 별도 supabaseAuth 인스턴스로 signInWithPassword 호출 — 현 세션을
// 갈아치우지 않도록 하려는 의도. Google 가입자는 password identity 자체가 없어
// signInWithPassword 가 invalid_credentials 로 실패하므로 자연히 차단됨.
router.post('/change-password', authMiddleware, async (req: AuthRequest, res: Response) => {
  const { current_password, new_password } = req.body;

  if (!current_password || !new_password) {
    res.status(400).json({ error: 'current_password and new_password are required' });
    return;
  }

  if (current_password === new_password) {
    res.status(400).json({
      error: 'new password must differ from the current one',
      code: 'SAME_PASSWORD',
    });
    return;
  }

  if (!PASSWORD_RE.test(new_password)) {
    res.status(400).json({
      error: 'password must be at least 8 characters and include a letter and a number',
      code: 'PASSWORD_FORMAT',
    });
    return;
  }

  // authMiddleware sets req.userId; pull email via admin API.
  const { data: userData, error: userErr } = await supabase.auth.admin.getUserById(
    req.userId!,
  );
  if (userErr || !userData.user?.email) {
    res.status(401).json({ error: 'user not found' });
    return;
  }
  const email = userData.user.email;

  // Verify current password without disturbing the caller's active session.
  const { error: verifyErr } = await supabaseAuth.auth.signInWithPassword({
    email,
    password: current_password,
  });
  if (verifyErr) {
    res.status(401).json({
      error: 'current password is incorrect',
      code: 'WRONG_CURRENT_PASSWORD',
    });
    return;
  }

  const { error: updateErr } = await supabase.auth.admin.updateUserById(req.userId!, {
    password: new_password,
  });
  if (updateErr) {
    res.status(500).json({ error: updateErr.message });
    return;
  }

  res.status(204).end();
});

// 회원 탈퇴 — anonymize in place (mig 012).
//
// auth.users 를 hard-delete 하면 profiles.id ON DELETE CASCADE 로 인해 매치/
// 메시지가 cascade 로 사라지고, 상대방은 채팅이 흔적 없이 증발하는 UX 를
//보게 된다. 그래서 auth.users 는 살리되 email/password 를 무작위 값으로
// 갈아치워 로그인 자체를 막고, profiles 행은 PII 필드만 비운 뒤
// `deleted_at` 을 찍는다. 매치/메시지는 그대로 유지되고, 상대 화면에서는
// FE 가 partner.deleted_at 을 보고 "탈퇴한 사용자" tombstone 으로 렌더링.
//
// Storage 사진·voice intro 오디오·ElevenLabs voice clone 등 외부 자원
// 정리는 별도 클린업 잡(향후) 대상.
// Best-effort cleanup of external assets owned by the deleted user. Each
// step is independently logged and swallowed so a single failure (e.g.
// ElevenLabs API hiccup, orphaned storage path) doesn't block the others.
//
// Buckets we wipe:
//   * photos                — `{userId}/...` folder of profile photos
//   * voice-intro-audio     — `{userId}/...` folder of multi-language TTS
//
// Buckets we keep (intentional):
//   * voice-messages — past TTS audio in chat history. Comparable to
//     retaining text messages: the partner already received them and
//     erasing only the audio mid-conversation is a worse UX than letting
//     the message bubble keep playing. The clone source is gone so no
//     further synthesis is possible.
async function cleanupDeletedUserAssets(userId: string, voiceCloneId: string | null) {
  const removeFolder = async (bucket: string, folder: string) => {
    const { data: files, error: listErr } = await supabase.storage.from(bucket).list(folder);
    if (listErr) throw new Error(`list ${bucket}/${folder}: ${listErr.message}`);
    if (!files || files.length === 0) return;
    const paths = files.map((f) => `${folder}/${f.name}`);
    const { error: rmErr } = await supabase.storage.from(bucket).remove(paths);
    if (rmErr) throw new Error(`remove ${bucket}/${folder}: ${rmErr.message}`);
  };

  // photo-watercolor-pipeline sprint: photos 버킷 하위 폴더 cleanup.
  //   * photos/{userId}/ — 옛 평면 구조 (mig 028 이전 업로드)
  //   * photos/{userId}/originals/ — 비동기 변환 전 원본 (변환 성공 시 즉시 폐기되지만
  //     실패/대기 중인 원본이 잔존 가능)
  //   * photos/{userId}/converted/ — 변환본 (현재 응답에서 노출 중인 사진)
  // list/remove 가 재귀적이지 않으므로 폴더별 호출. 빈 폴더는 무해 (list 가 빈 배열).
  const tasks: Array<{ name: string; run: () => Promise<unknown> }> = [
    { name: 'photos', run: () => removeFolder('photos', userId) },
    { name: 'photos-originals', run: () => removeFolder('photos', `${userId}/originals`) },
    { name: 'photos-converted', run: () => removeFolder('photos', `${userId}/converted`) },
    { name: 'voice-intro-audio', run: () => removeFolder('voice-intro-audio', userId) },
  ];

  if (voiceCloneId) {
    tasks.push({ name: 'elevenlabs-clone', run: () => deleteVoiceClone(voiceCloneId) });
  }

  const results = await Promise.allSettled(tasks.map((t) => t.run()));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[deleteAccount cleanup] ${tasks[i].name} failed for ${userId}:`, r.reason);
    }
  });
}

router.delete('/account', authMiddleware, async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;

  // Capture the voice-clone id before we anonymize — once the profile row
  // is cleared we lose the reference to the ElevenLabs side. Photos folder
  // is keyed by userId so we don't need to capture URLs.
  const { data: prevProfile } = await supabase
    .from('profiles')
    .select('elevenlabs_voice_id')
    .eq('id', userId)
    .maybeSingle();
  const voiceCloneId = (prevProfile?.elevenlabs_voice_id as string | null) ?? null;

  // (1) Anonymize the profile row. NOT NULL columns (display_name,
  // birth_date, gender, nationality, language) are kept satisfied with
  // sentinel values — display_name='' triggers the FE tombstone fallback
  // (resolves to "탈퇴한 사용자" via i18n). Voice/photo PII is nulled out.
  // is_active=false drops the row out of discover and the public
  // "Anyone can read active profiles" RLS policy (so getPartnerDetail
  // also can't fetch the cleared bio/birth_date/interests fields).
  // mig 011 의 voice_intro_translations / voice_intro_audio_urls /
  // voice_intro_audio_status 는 JSONB NOT NULL DEFAULT '{}'. null 대신
  // 빈 객체로 비운다. voice_intro_phrase_id 는 zod 페이로드 필드일 뿐
  // DB 컬럼이 아니므로 update 페이로드에서 제외.
  const { error: profErr } = await supabase
    .from('profiles')
    .update({
      display_name: '',
      interests: [],
      voice_intro: null,
      voice_intro_audio_urls: {},
      voice_intro_translations: {},
      voice_intro_audio_status: {},
      elevenlabs_voice_id: null,
      voice_clone_status: 'pending',
      is_active: false,
      deleted_at: new Date().toISOString(),
    })
    .eq('id', userId);
  if (profErr) {
    res.status(500).json({ error: profErr.message });
    return;
  }

  // (1.5) push-notifications sprint: device_tokens 동기 DELETE.
  // mig 016 의 FK CASCADE 는 auth.users 가 실제 DELETE 될 때만 발화하는데,
  // 본 라우트는 auth.users 를 anonymize 만 하므로 CASCADE 가 fire 하지 않는다.
  // 미정리 시 탈퇴한 사용자에게 푸시가 계속 발송될 수 있고 expo_push_token
  // (개인 단말 식별자) 이 서버에 잔존해 GDPR/PIPA 데이터 삭제권 위반.
  // cleanup task (fire-and-forget) 가 아니라 anonymize 이전 동기 경로로 실행
  // — 실패 시 500 응답으로 노출하여 inconsistent state 를 호출자가 인지.
  const { error: tokenErr } = await supabase
    .from('device_tokens')
    .delete()
    .eq('user_id', userId);
  if (tokenErr) {
    res.status(500).json({ error: tokenErr.message });
    return;
  }

  // (1.6) 폐기됨 — evidence-hold-on-delete sprint (2026-05-27) 에서
  // moderation_blocks + freeze_events 동기 DELETE 를 제거하고
  // cleanupAuditTables.ts 의 365 일 cron sweep 으로 이전 (PIPA §21(1) 단서 +
  // §21(3) 분리 저장 + 정통망법 §44조의10 명예훼손 분쟁조정부 + 전기통신사업법
  // §83 수사기관 통신자료 제공 요청). 동기 DELETE 정책은 GDPR/PIPA 데이터
  // 삭제권을 즉시 충족하는 대신 audit 보존을 손실시켰음. 1년 시한부 보존이
  // 두 요건의 균형점.

  // (1.7) mig 022 match_mutes 동기 DELETE — device_tokens / moderation_blocks
  // 와 동일 회귀 (anonymize 가 CASCADE 를 fire 시키지 않음). mute 이력은 보존
  // 가치가 없고 신규 사용자에게 옛 매치의 mute 가 잔존하면 푸시 silent skip
  // 회귀가 생기므로 동기 DELETE 가 필수.
  const { error: matchMutesErr } = await supabase
    .from('match_mutes')
    .delete()
    .eq('user_id', userId);
  if (matchMutesErr) {
    res.status(500).json({ error: matchMutesErr.message });
    return;
  }

  // (1.8) photo-watercolor-pipeline sprint: profile_photos 동기 DELETE.
  // mig 028 의 FK CASCADE (profiles ON DELETE CASCADE) 는 profiles 가 실제 DELETE
  // 될 때만 fire 하는데 (1) 단계가 anonymize 만 함 — device_tokens / moderation_blocks
  // 와 동일 회귀. profile_photos 미정리 시 (a) discover/match 라우트가 join 으로
  // 옛 변환본 노출 (b) Storage 객체 잔존 으로 GDPR/PIPA 데이터 삭제권 위반.
  // 신규 user-linked 테이블 추가 시 deleteAccount 동기 정리 룰 (CLAUDE.md) 적용.
  const { error: photoRowsErr } = await supabase
    .from('profile_photos')
    .delete()
    .eq('user_id', userId);
  if (photoRowsErr) {
    res.status(500).json({ error: photoRowsErr.message });
    return;
  }

  // (1.9) evidence-hold-on-delete sprint: swipes 양방향 동기 DELETE.
  // mig 001 의 swipes FK CASCADE 는 profiles 가 실제 DELETE 될 때만 발화하는데
  // (1) 단계에서 profiles 는 anonymize 만 한다 — push-notifications /
  // message-moderation-v1 / match-mutes 와 동일 회귀.
  // 잔존 가치 0 — 본인 디스커버는 어차피 is_active=false 로 빠지고, 상대방
  // "받은 좋아요" 탭은 swipes JOIN 후 is_active 필터로 자연 제외. 두 row
  // 그룹 (swiper / swiped) 가 동일 row 를 가리킬 수 없으므로 atomic-failure
  // 모드 없음. 2 호출 각각의 error 를 destructure 해 가시화 (silent-success 룰).
  const { error: swipesSwiperErr } = await supabase
    .from('swipes')
    .delete()
    .eq('swiper_id', userId);
  if (swipesSwiperErr) {
    res.status(500).json({ error: swipesSwiperErr.message });
    return;
  }
  const { error: swipesSwipedErr } = await supabase
    .from('swipes')
    .delete()
    .eq('swiped_id', userId);
  if (swipesSwipedErr) {
    res.status(500).json({ error: swipesSwipedErr.message });
    return;
  }

  // (1.10) evidence-hold-on-delete sprint: user_preferences 동기 DELETE.
  // mig 002 의 FK CASCADE 는 profiles 가 실제 DELETE 될 때만 발화하는데 동일
  // anonymize 한계 — strategist G1 표면화 (push-notifications/message-moderation-v1
  // 의 반복 패턴). 매칭 선호도 + 알림 옵트아웃 (notify_messages/notify_matches)
  // 은 PIPA §21 즉시 파기 대상. 재가입 시 새 row INSERT 라 잔존 가치 0.
  const { error: prefsErr } = await supabase
    .from('user_preferences')
    .delete()
    .eq('user_id', userId);
  if (prefsErr) {
    res.status(500).json({ error: prefsErr.message });
    return;
  }

  // (2) Anonymize the auth.users row so the user can no longer authenticate
  // and their original email becomes free for re-registration. Email goes to
  // a non-routable .local address; password is set to 32 bytes of random hex
  // — the user has no way to know it. user_metadata flags the row for audit.
  const anonEmail = `deleted-${userId}@deleted.local`;
  const anonPassword = randomBytes(32).toString('hex');
  const { error: authErr } = await supabase.auth.admin.updateUserById(userId, {
    email: anonEmail,
    password: anonPassword,
    user_metadata: { deleted: true, deleted_at: new Date().toISOString() },
  });
  if (authErr) {
    // Profile is already anonymized at this point; surface the error so the
    // caller knows auth.users is in an inconsistent state and can retry.
    res.status(500).json({ error: authErr.message });
    return;
  }

  // Note: existing refresh tokens on other devices remain valid until they
  // expire — admin.signOut takes a JWT, not a userId, so we can't broadcast
  // a global sign-out from here. Acceptable trade-off for v1: the account
  // is fully anonymized so even an active session sees its own tombstone.

  // (3) Fire-and-forget cleanup of external assets (Supabase Storage +
  // ElevenLabs clone). Errors logged inside; we never block the response on
  // these because the DB-level anonymization above is the privacy contract.
  cleanupDeletedUserAssets(userId, voiceCloneId).catch((e) => {
    console.error('[deleteAccount cleanup] uncaught:', e);
  });

  res.status(204).end();
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

  if (data.user && (await isAccountFrozen(data.user.id))) {
    res.status(403).json({ error: 'Account frozen', code: 'account_frozen' });
    return;
  }

  res.json({
    access_token: data.session?.access_token,
    refresh_token: data.session?.refresh_token,
  });
});

export default router;
