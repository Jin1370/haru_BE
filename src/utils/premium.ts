// 프리미엄 entitlement 판정 (런칭 쿠폰 + 향후 구독 공유).
//
// profiles.premium_until (mig 033) 이 미래면 프리미엄.
//   * 무료 티어: 음성 10통/일, 받은좋아요 하루 1명, 광고 노출.
//   * 프리미엄 : 음성 30통/일, 받은좋아요 무제한, 광고 없음.
// 쿠폰은 premium_until 을 보조금 기간 이하로 set → 해당 시각에 자동 무료 복귀.
export function isPremium(premiumUntil: string | null | undefined): boolean {
  if (!premiumUntil) return false;
  return new Date(premiumUntil).getTime() > Date.now();
}
