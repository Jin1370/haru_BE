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

// 어드민 시크릿 가드 — 모든 admin 라우트 진입 차단
function adminSecretGuard(req: Request, res: Response, next: NextFunction): void {
  const provided = req.headers['x-admin-secret'];
  if (typeof provided !== 'string' || provided !== env.admin.secret) {
    res.status(401).json({ error: 'Invalid admin secret' });
    return;
  }
  next();
}

// 어드민 시크릿 검증 (대시보드 로그인용)
// 클라이언트가 입력한 secret 이 유효한지 확인. 200 이면 sessionStorage 에 저장.
router.post('/auth/verify', adminSecretGuard, (_req, res) => {
  res.json({ ok: true });
});

// dev seed 계정 목록 조회
// auth.users 에서 user_metadata.is_dev_seed=true 인 항목 + 각자 profile 정보 결합.
router.get('/accounts', adminSecretGuard, async (_req, res) => {
  try {
    // 1) auth.users 페이지네이션 스캔 (seed 마커 필터)
    const seedUsers: { id: string; email: string | null; persona_index: number | null }[] = [];
    const perPage = 1000;
    for (let page = 1; ; page++) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
      if (error) {
        res.status(500).json({ error: `listUsers failed: ${error.message}` });
        return;
      }
      for (const user of data.users) {
        const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
        if (meta.is_dev_seed === true) {
          seedUsers.push({
            id: user.id,
            email: user.email ?? null,
            persona_index:
              typeof meta.persona_index === 'number' ? meta.persona_index : null,
          });
        }
      }
      if (data.users.length < perPage) break;
    }

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

export default router;
