// AdMob SSV 서명 검증 — 구글과 같은 방식(ECDSA P-256 + SHA-256, base64url)으로
// 서명한 쿼리스트링을 통과시키고, 값 하나라도 바꾸면 거부하는지.

import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createSign } from 'crypto';
import { verifyAdmobSignature } from '../src/routes/rewards';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function signed(message: string): string {
  const signer = createSign('sha256');
  signer.update(message);
  const sig = signer.sign(privateKey).toString('base64url');
  return `${message}&signature=${sig}&key_id=1234`;
}

const MESSAGE =
  'ad_network=5450213213286189855&ad_unit=1234567890&reward_amount=1&reward_item=star' +
  '&timestamp=1507770365237823&transaction_id=123&user_id=11111111-1111-1111-1111-111111111111';

describe('verifyAdmobSignature', () => {
  it('구글 키로 서명된 쿼리는 통과', () => {
    expect(verifyAdmobSignature(signed(MESSAGE), pem)).toBe(true);
  });

  it('user_id 를 바꾸면 거부 (다른 사람 계정으로 보상 가로채기)', () => {
    const tampered = signed(MESSAGE).replace(
      'user_id=11111111-1111-1111-1111-111111111111',
      'user_id=22222222-2222-2222-2222-222222222222',
    );
    expect(verifyAdmobSignature(tampered, pem)).toBe(false);
  });

  it('서명이 없으면 거부', () => {
    expect(verifyAdmobSignature(MESSAGE, pem)).toBe(false);
  });
});
