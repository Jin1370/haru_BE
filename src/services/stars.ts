import { supabase } from '../config/supabase';

// 별사탕 원장 (mig 059 star_ledger). 잔액은 항상 원장 합계에서 계산한다.

export class InsufficientStarsError extends Error {
  constructor() {
    super('insufficient_stars');
  }
}

export type StarBalance = { free: number; paid: number };

export async function getStarBalance(userId: string): Promise<StarBalance> {
  const { data, error } = await supabase.rpc('star_balance', { p_user: userId });
  if (error) throw new Error(`star_balance: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as StarBalance | undefined;
  return { free: row?.free ?? 0, paid: row?.paid ?? 0 };
}

// 잔액 확인과 차감을 DB 함수 한 번으로 (advisory lock). 남은 총 잔액 반환.
export async function spendStars(userId: string, amount: number, kind: string): Promise<number> {
  const { data, error } = await supabase.rpc('spend_stars', {
    p_user: userId,
    p_amount: amount,
    p_kind: kind,
  });
  if (error) {
    if (error.message.includes('insufficient_stars')) throw new InsufficientStarsError();
    throw new Error(`spend_stars: ${error.message}`);
  }
  return data as number;
}

// 충전. ref(외부 거래 ID)가 이미 있으면 지급하지 않고 false — 웹훅 재시도 대비.
export async function grantStars(
  userId: string,
  amount: number,
  paid: boolean,
  kind: 'ad' | 'purchase' | 'refund',
  ref: string | null,
): Promise<boolean> {
  const { error } = await supabase
    .from('star_ledger')
    .insert({ user_id: userId, delta: amount, paid, kind, ref });
  if (error) {
    if (error.code === '23505') return false;
    throw new Error(`star grant: ${error.message}`);
  }
  return true;
}

// fromIso 이후 kind 로 오간 별사탕 개수 (광고 하루 횟수 = 합/1, 오늘 카드 리셋 = 합/4).
// spend_stars 가 한 번에 최대 2줄(무료+유료)을 써서 줄 수가 아니라 개수 합으로 센다.
export async function sumLedger(userId: string, kind: string, fromIso: string): Promise<number> {
  const { data, error } = await supabase
    .from('star_ledger')
    .select('delta')
    .eq('user_id', userId)
    .eq('kind', kind)
    .gte('created_at', fromIso);
  if (error) throw new Error(`star_ledger count: ${error.message}`);
  return (data ?? []).reduce((sum: number, r: { delta: number }) => sum + Math.abs(r.delta), 0);
}
