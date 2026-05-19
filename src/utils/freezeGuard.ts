import { Response, NextFunction } from 'express';
import { supabase } from '../config/supabase';
import { AuthRequest } from '../types';

// message-moderation-v1 (PR2): freeze 사용자 mutating 라우트 가드.
//
// 사용 패턴:
//   import { requireNotFrozen } from '../utils/freezeGuard';
//   router.use(authMiddleware);
//   router.use(requireNotFrozen);
//
// 검증 기준 (둘 다 견고하게):
//   * profiles.is_active = false  → freeze (legacy 정책 — deleteAccount/admin 가 set)
//   * profiles.frozen_at IS NOT NULL → freeze (PR2 의 신규 마커)
//
// 응답: 403 + `{ error: 'Account frozen', code: 'account_frozen' }`.
// FE 의 services/api.ts 글로벌 핸들러가 `code` 매칭으로 모달 + 로그아웃 흐름 발화.
//
// 미들웨어로 도입한 이유 (architect plan Section 5.2 의 "라우트별 인라인" 결정을
// 자율 보정): mutating 라우트가 6개 이상으로 늘었고 각 라우트마다 동일 한 줄을
// 반복해야 하므로 router.use() 가 더 깔끔. 본인 프로필 조회/로그아웃 같이 freeze
// 통과해야 하는 면은 라우터 자체가 분리돼 있으므로 미들웨어 적용 단위가 라우터
// 단위로 깔끔하게 떨어진다.
//
// 추가 select 1건이 mutating 핫패스에 들어가지만, push-notifications sprint 도
// 동일 패턴 (`profiles.is_active`/`deleted_at` 검증) 이라 baseline 흡수됨.
export async function requireNotFrozen(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // authMiddleware 가 먼저 통과되어야 함 — userId 가 없으면 다음으로 (다음 미들웨어가
  // 401 분기 처리).
  if (!req.userId) {
    next();
    return;
  }

  const { data, error } = await supabase
    .from('profiles')
    .select('is_active, frozen_at')
    .eq('id', req.userId)
    .maybeSingle();

  // 프로필 조회 실패는 freeze 와 무관 — 다음 핸들러로 통과시켜 본 라우트 자체의
  // 에러 처리로 위임 (404 등). 본 가드가 모든 에러를 흡수하면 라우트별 에러
  // 시맨틱이 깨진다.
  if (error || !data) {
    next();
    return;
  }

  // mig 021 미적용 환경 안전성: 컬럼이 없으면 select 결과에서 키가 빠져 undefined 가
  // 된다. `!== null` 비교는 undefined 를 통과시켜 모든 사용자를 freeze 로 오인식하는
  // 회귀를 만든다. Boolean truthy 변환으로 NULL/undefined 둘 다 정상으로 처리.
  // (frozen_at 가 string 이면 truthy → freeze 로 인지.)
  const isFrozen = data.is_active === false || Boolean(data.frozen_at);
  if (isFrozen) {
    res.status(403).json({
      error: 'Account frozen',
      code: 'account_frozen',
    });
    return;
  }

  next();
}
