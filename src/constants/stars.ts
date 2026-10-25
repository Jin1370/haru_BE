// 별사탕 정책 상수 — _workspace/monetization/decisions.md 와 동일하게 유지.
// FE 표시 문구(i18n)도 이 숫자를 쓰므로 바꿀 때 같이 고친다.

export const CARD_DAILY_FREE = 10;
export const CARD_RESET_COST = 4;
export const CARD_RESET_AMOUNT = 10;

export const LIKE_STAR_COST = 1;

export const REVEAL_STAR_COST = 2;
export const REVEAL_FREE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const AD_REWARD_STARS = 1;
export const AD_REWARD_DAILY_MAX = 2;

// 스토어 상품 ID → 지급 개수. 양 스토어 동일 ID.
export const STAR_PRODUCTS: Record<string, number> = {
  stars_30: 30,
  stars_80: 80,
  // iOS App Store 제품 ID
  star_30: 30,
  star_80: 80,
};
