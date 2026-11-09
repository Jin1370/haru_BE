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

// 받은 좋아요 유료 공개. 차감과 공개 기록(무료·유료 차감 개수 포함)을 한 트랜잭션으로
// 처리한다 (mig 062). 이미 공개됐으면(연타) 차감 없이 false.
export async function revealLike(viewerId: string, likerId: string, stars: number): Promise<boolean> {
  const { error } = await supabase.rpc('reveal_like', {
    p_viewer: viewerId,
    p_liker: likerId,
    p_stars: stars,
  });
  if (!error) return true;
  if (error.code === '23505') return false;
  if (error.message.includes('insufficient_stars')) throw new InsufficientStarsError();
  throw new Error(`reveal_like: ${error.message}`);
}

// 유료 공개를 쓴 그대로(무료분은 무료, 유료분은 유료) 돌려주고 공개를 취소한다.
// 원장 ref 유니크로 같은 공개를 두 번 돌려주지 않는다. 돌려준 개수 반환 (없으면 0).
export async function refundLikeReveal(viewerId: string, likerId: string): Promise<number> {
  const { data: reveal, error } = await supabase
    .from('like_reveals')
    .select('paid, free_spent, paid_spent')
    .eq('viewer_id', viewerId)
    .eq('liker_id', likerId)
    .maybeSingle();
  if (error) throw new Error(`like_reveals: ${error.message}`);
  if (!reveal?.paid) return 0;

  const ref = `like_reveal:${viewerId}:${likerId}`;
  const rows = [
    { delta: reveal.free_spent as number, paid: false, ref: `${ref}:free` },
    { delta: reveal.paid_spent as number, paid: true, ref: `${ref}:paid` },
  ]
    .filter((r) => r.delta > 0)
    .map((r) => ({ ...r, user_id: viewerId, kind: 'refund' }));
  let refunded = 0;
  if (rows.length > 0) {
    const { error: insertErr } = await supabase.from('star_ledger').insert(rows);
    if (insertErr && insertErr.code !== '23505') throw new Error(`star refund: ${insertErr.message}`);
    if (!insertErr) refunded = rows.reduce((sum, r) => sum + r.delta, 0);
  }
  // 상대가 돌아와도(차단 해제 등) 공짜로 열린 채 남지 않게 공개를 지운다. 실패해도 위
  // ref 유니크가 재환급을 막는다.
  const { error: deleteErr } = await supabase
    .from('like_reveals')
    .delete()
    .eq('viewer_id', viewerId)
    .eq('liker_id', likerId);
  if (deleteErr) console.error('[refundLikeReveal] reveal delete failed:', deleteErr.message);
  return refunded;
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
