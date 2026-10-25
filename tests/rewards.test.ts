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

  // AdMob 콘솔 'URL 확인' 이 실제로 보낸 요청 (2026-10-14). 보상 이름이 한글이라
  // 구글은 URL 디코딩된 문자열에 서명한다 — 인코딩된 채 검증하면 실패했다.
  it('실제 구글 서명 (비ASCII 보상 이름) 통과', () => {
    const googlePem =
      '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE+nzvoGqvDeB9+SzE6igTl7TyK4JB\nbglwir9oTcQta8NuG26ZpZFxt+F2NDk7asTE6/2Yc8i1ATcGIqtuS5hv0Q==\n-----END PUBLIC KEY-----';
    const query =
      'ad_network=5450213213286189855&ad_unit=1234567890&reward_amount=1&reward_item=%EB%B3%84%EC%82%AC%ED%83%95&timestamp=1791959559346&transaction_id=123456789&signature=MEYCIQCVKKkIvtbK38hcEoxxm3E8rlcmCvmWR9-HMYFjCFsUxAIhANjeLi7QqS0ooli9WqS9ZfaETrPEQ9tLrK0WsFml6qK_&key_id=3335741209';
    expect(verifyAdmobSignature(query, googlePem)).toBe(true);
  });
});
