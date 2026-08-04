import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../config/supabase';
import { env } from '../config/env';

// dev/QA 어드민 라우트. 활성 조건: env.admin.dashboardEnabled === true.
// index.ts 에서 환경변수가 true 일 때만 mount → 출시 빌드에서는 라우트 자체 부재.
//
// 본 라우트는 임퍼소네이션 대상 dev 계정 목록만 노출하며, 채팅/스와이프/매치
// 같은 도메인 작업은 기존 /api/* 라우트를 X-Admin-Impersonate 헤더로 재사용한다.
// (authMiddleware 가 임퍼소네이션 경로를 처리)

const router = Router();

// 요청자가 어떤 운영자인지. null = 슈퍼유저(ADMIN_SECRET 단독) → 전 계정 접근.
export type AdminOperator = string | null;

// 제시된 (아이디, 시크릿) 조합을 검증해 운영자를 해석한다.
//   * ADMIN_SECRET 와 일치 → 슈퍼유저(null)
//   * ADMIN_USERS 의 (id, pw) 쌍과 일치 → 그 운영자 id
//   * 그 외 → undefined (인증 실패)
export function resolveAdminOperator(
  userId: unknown,
  secret: unknown,
): AdminOperator | undefined {
  if (typeof secret !== 'string' || secret.length === 0) return undefined;
  if (secret === env.admin.secret) return null;
  if (typeof userId !== 'string' || userId.length === 0) return undefined;
  const expected = env.admin.users[userId];
  return expected && expected === secret ? userId : undefined;
}

// 어드민 가드 — 모든 admin 라우트 진입 차단 + req 에 운영자 주입.
function adminSecretGuard(req: Request, res: Response, next: NextFunction): void {
  const operator = resolveAdminOperator(
    req.headers['x-admin-user'],
    req.headers['x-admin-secret'],
  );
  if (operator === undefined) {
    res.status(401).json({ error: 'Invalid admin credentials' });
    return;
  }
  (req as Request & { adminOperator?: AdminOperator }).adminOperator = operator;
  next();
}

// 어드민 시크릿 검증 (대시보드 로그인용)
// 클라이언트가 입력한 secret 이 유효한지 확인. 200 이면 sessionStorage 에 저장.
router.post('/auth/verify', adminSecretGuard, (req, res) => {
  const operator = (req as Request & { adminOperator?: AdminOperator }).adminOperator ?? null;
  res.json({ ok: true, operator });
});

// dev seed 계정 목록 조회
// auth.users 에서 user_metadata.is_dev_seed=true 인 항목 + 각자 profile 정보 결합.
router.get('/accounts', adminSecretGuard, async (_req: Request, res: Response) => {
  try {
    // 1) auth.users 페이지네이션 스캔 (seed 마커 필터) — notify-sink 와 공용 헬퍼.
    // listUsers 실패 throw 는 아래 catch 가 동일 문구의 500 으로 변환.
    const operator = (_req as Request & { adminOperator?: AdminOperator }).adminOperator ?? null;
    // 소유자 격리 — 슈퍼유저가 아니면 dev_owner 가 자기 id 인 계정만 노출.
    const seedUsers = (await listSeedUsers()).filter(
      (u) => operator === null || u.owner === operator,
    );

    if (seedUsers.length === 0) {
      res.json({ accounts: [] });
      return;
    }

    // 2) profiles join
    const ids = seedUsers.map((u) => u.id);
    const { data: profiles, error: profileError } = await supabase
      .from('profiles')
      .select(
        'id, display_name, gender, nationality, language, voice_intro, elevenlabs_voice_id, voice_clone_status',
      )
      .in('id', ids);

    if (profileError) {
      res.status(500).json({ error: `profiles fetch failed: ${profileError.message}` });
      return;
    }

    const profileMap = new Map(profiles?.map((p) => [p.id, p]) ?? []);

    // photo-watercolor-pipeline (mig 028): 프로필 사진은 더 이상 profiles.photos
    // 배열이 아니라 profile_photos 테이블(converted_url)에 산다. 디스커버
    // (swipe.ts) 와 동일하게 status='ready' 사진을 position 오름차순으로 가져와
    // 사용자별 메인(가장 낮은 position)의 converted_url 을 사용한다.
    const photoByUser = new Map<string, string>();
    const { data: photoRows, error: photoError } = await supabase
      .from('profile_photos')
      .select('user_id, position, converted_url, status')
      .in('user_id', ids)
      .eq('status', 'ready')
      .order('position', { ascending: true });
    if (photoError) {
      console.error('[admin.profile_photos_select_failed]', photoError.message);
    } else {
      ((photoRows ?? []) as Array<{ user_id: string; converted_url: string | null }>).forEach((r) => {
        // order by position ASC → 첫 entry 가 메인. 이미 있으면 덮어쓰지 않음.
        if (r.converted_url && !photoByUser.has(r.user_id)) {
          photoByUser.set(r.user_id, r.converted_url);
        }
      });
    }

    const accounts = seedUsers
      .map((u) => {
        const profile = profileMap.get(u.id);
        return {
          user_id: u.id,
          email: u.email,
          persona_index: u.persona_index,
          display_name: profile?.display_name ?? null,
          gender: profile?.gender ?? null,
          nationality: profile?.nationality ?? null,
          language: profile?.language ?? null,
          photo: photoByUser.get(u.id) ?? null,
          voice_intro: profile?.voice_intro ?? null,
          voice_clone_status: profile?.voice_clone_status ?? null,
        };
      })
      .sort((a, b) => {
        // display_name 자연 정렬 — 'Test10' 이 'Test2' 앞에 오는 ASCII 비교 회피.
        // numeric:true 가 'Test2' < 'Test10' 보장. sensitivity:'base' 로 대소문자 무시.
        // null display_name 은 뒤로.
        if (a.display_name === null && b.display_name === null) return 0;
        if (a.display_name === null) return 1;
        if (b.display_name === null) return -1;
        return a.display_name.localeCompare(b.display_name, undefined, {
          numeric: true,
          sensitivity: 'base',
        });
      });

    res.json({ accounts });
  } catch (err) {
    console.error('[admin/accounts] error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// ===== dev 알림 싱크 (mig 040) =====
//
// 테스터 폰 1대로 모든 dev seed 계정의 푸시 알림을 받기 위한 매핑 관리.
// 폰에 로그인된 실계정의 expo_push_token 을 모든 dev seed 계정 앞으로 복제한다.
// sendPushToUser 가 (어드민 활성 시) dev_notification_sinks 도 조회해 발송.

// is_dev_seed=true 인 auth.users 전체 스캔 (페이지네이션). /accounts + notify-sink 공용.
async function listSeedUsers(): Promise<
  { id: string; email: string | null; persona_index: number | null; owner: string | null }[]
> {
  const seedUsers: {
    id: string;
    email: string | null;
    persona_index: number | null;
    owner: string | null;
  }[] = [];
  const perPage = 1000;
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    for (const user of data.users) {
      const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
      if (meta.is_dev_seed === true) {
        seedUsers.push({
          id: user.id,
          email: user.email ?? null,
          persona_index: typeof meta.persona_index === 'number' ? meta.persona_index : null,
          owner: typeof meta.dev_owner === 'string' ? meta.dev_owner : null,
        });
      }
    }
    if (data.users.length < perPage) break;
  }
  return seedUsers;
}

// 현재 싱크 상태 조회.
router.get('/notify-sink', adminSecretGuard, async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('dev_notification_sinks')
      .select('dev_user_id, expo_push_token, label');
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    // 운영자 격리 — 자기 소유 dev 계정의 싱크만 집계.
    const operator = (_req as Request & { adminOperator?: AdminOperator }).adminOperator ?? null;
    const ownedIds =
      operator === null
        ? null
        : new Set((await listSeedUsers()).filter((u) => u.owner === operator).map((u) => u.id));
    const rows = (data ?? []).filter((r) => !ownedIds || ownedIds.has(r.dev_user_id));
    const tokens = new Set(rows.map((r) => r.expo_push_token));
    const accounts = new Set(rows.map((r) => r.dev_user_id));

    // 어떤 "마스터 계정"(=알림을 실제로 받는 폰의 로그인 계정)이 붙어 있는지 역추적.
    // sink 행에는 토큰만 있으므로 device_tokens 로 소유자를 찾고 이메일을 조회한다.
    // 토큰이 회전/폐기되어 device_tokens 에서 사라졌으면 목록에서 자연 제외된다.
    const masters: string[] = [];
    if (tokens.size > 0) {
      const { data: owners, error: ownerErr } = await supabase
        .from('device_tokens')
        .select('user_id')
        .in('expo_push_token', [...tokens]);
      if (ownerErr) {
        console.error('[admin/notify-sink GET] device_tokens lookup failed:', ownerErr.message);
      } else {
        for (const userId of new Set((owners ?? []).map((o) => o.user_id as string))) {
          const { data: userData } = await supabase.auth.admin.getUserById(userId);
          const email = userData?.user?.email;
          if (email) masters.push(email);
        }
      }
    }

    res.json({
      linked_accounts: accounts.size,
      tokens: tokens.size,
      labels: [...new Set(rows.map((r) => r.label).filter(Boolean))] as string[],
      masters,
    });
  } catch (err) {
    console.error('[admin/notify-sink GET] error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// 싱크 연결 — body { sink_email }. 해당 계정의 device_tokens 를 모든 dev seed
// 계정 앞으로 복제. 폰 토큰이 회전(rotate)하면 다시 호출해 재동기화한다.
router.post('/notify-sink', adminSecretGuard, async (req, res) => {
  try {
    const sinkEmail =
      typeof req.body?.sink_email === 'string' ? req.body.sink_email.trim() : '';
    if (!sinkEmail) {
      res.status(400).json({ error: 'sink_email 이 필요합니다' });
      return;
    }

    // 1) 이메일로 사용자 찾기 (전체 스캔 — admin SDK 에 getByEmail 없음).
    let sinkUserId: string | null = null;
    const perPage = 1000;
    for (let page = 1; ; page++) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
      if (error) {
        res.status(500).json({ error: `listUsers failed: ${error.message}` });
        return;
      }
      const hit = data.users.find(
        (u) => (u.email ?? '').toLowerCase() === sinkEmail.toLowerCase(),
      );
      if (hit) {
        sinkUserId = hit.id;
        break;
      }
      if (data.users.length < perPage) break;
    }
    if (!sinkUserId) {
      res.status(404).json({ error: `'${sinkEmail}' 계정을 찾을 수 없습니다` });
      return;
    }

    // 2) 그 계정의 푸시 토큰 (폰에서 로그인 + 알림 권한 허용 시 등록됨).
    const { data: srcTokens, error: tokErr } = await supabase
      .from('device_tokens')
      .select('expo_push_token, platform')
      .eq('user_id', sinkUserId);
    if (tokErr) {
      res.status(500).json({ error: tokErr.message });
      return;
    }
    if (!srcTokens || srcTokens.length === 0) {
      res.status(400).json({
        error:
          '해당 계정에 등록된 푸시 토큰이 없습니다. 그 계정으로 폰에 로그인 + 알림 권한 허용 후 다시 시도하세요.',
      });
      return;
    }

    // 3) dev seed 계정 + 표시명. 운영자 격리 — 자기 소유 계정에만 연결한다
    //    (남의 계정 알림을 자기 폰으로 돌리는 것 차단).
    const operator = (req as Request & { adminOperator?: AdminOperator }).adminOperator ?? null;
    const seedUsers = (await listSeedUsers()).filter(
      (u) => operator === null || u.owner === operator,
    );
    if (seedUsers.length === 0) {
      res.status(400).json({ error: '연결할 dev seed 계정이 없습니다' });
      return;
    }
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, display_name')
      .in(
        'id',
        seedUsers.map((u) => u.id),
      );
    const nameById = new Map((profiles ?? []).map((p) => [p.id, p.display_name as string]));

    // 4) 모든 (dev 계정 × 토큰) 조합 upsert.
    const rows = seedUsers.flatMap((acc) =>
      srcTokens.map((tk) => ({
        dev_user_id: acc.id,
        expo_push_token: tk.expo_push_token,
        platform: tk.platform,
        // label 은 알림 제목 "haru · <label>" 에 노출. 테스터 요청으로 닉네임
        // 대신 이메일 사용 (계정 식별이 더 명확). 이메일 없으면 표시명 폴백.
        label: acc.email ?? nameById.get(acc.id) ?? null,
      })),
    );
    const { error: upErr } = await supabase
      .from('dev_notification_sinks')
      .upsert(rows, { onConflict: 'dev_user_id,expo_push_token' });
    if (upErr) {
      res.status(500).json({ error: upErr.message });
      return;
    }

    res.json({
      ok: true,
      sink_email: sinkEmail,
      account_count: seedUsers.length,
      token_count: srcTokens.length,
    });
  } catch (err) {
    console.error('[admin/notify-sink POST] error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// 싱크 전체 해제.
router.delete('/notify-sink', adminSecretGuard, async (_req: Request, res: Response) => {
  try {
    const { error, count } = await supabase
      .from('dev_notification_sinks')
      .delete({ count: 'exact' })
      .not('id', 'is', null);
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json({ cleared: count ?? 0 });
  } catch (err) {
    console.error('[admin/notify-sink DELETE] error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

export default router;
