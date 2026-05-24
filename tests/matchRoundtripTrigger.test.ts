import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// match-roundtrip-realtime sprint: 사진 잠금 해제 임계치 (UNLOCK_MAIN_PHOTO_AT,
// UNLOCK_ALL_PHOTOS_AT) 는 3 곳에 동일 값으로 존재해야 한다.
//
//   1) haru_BE/src/constants/chat.ts                       — BE TS 상수
//   2) haru_BE/supabase/migrations/014_match_roundtrip.sql — AFTER INSERT 트리거 SQL 리터럴
//   3) haru_FE/src/constants/photoAccess.ts                — FE TS 상수
//
// 한 곳이라도 drift 하면 fail. PR 마다 CI 가 1차 방어선.

const REPO_ROOT = resolve(__dirname, '..', '..');

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

// haru_BE/src/constants/chat.ts 의 export 값을 정규식으로 추출.
// import 하면 vitest 가 dist 안전하게 처리하므로 그래도 되지만,
// 본 테스트의 의의는 "소스 파일 텍스트 그대로 비교" 이므로 정규식 추출 유지.
function parseTSConstant(text: string, name: string): number | null {
  const re = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(\\d+)\\s*;`);
  const m = text.match(re);
  return m ? Number(m[1]) : null;
}

function parseSQLLiteralAfter(text: string, marker: string): number | null {
  // 014 의 `IF ... new_count >= 5 THEN` 형태에서 marker 직후 정수를 추출.
  // marker 는 unique 한 SQL 조각 (예: 'new_count >= ').
  const idx = text.indexOf(marker);
  if (idx < 0) return null;
  const tail = text.slice(idx + marker.length);
  const m = tail.match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}

describe('photo unlock threshold 3-way sync (BE constants / 014 SQL / FE constants)', () => {
  const beConstantsPath = resolve(
    REPO_ROOT,
    'haru_BE',
    'src',
    'constants',
    'chat.ts',
  );
  const sqlPath = resolve(
    REPO_ROOT,
    'haru_BE',
    'supabase',
    'migrations',
    '014_match_roundtrip.sql',
  );
  const feConstantsPath = resolve(
    REPO_ROOT,
    'haru_FE',
    'src',
    'constants',
    'photoAccess.ts',
  );

  const beText = readText(beConstantsPath);
  const sqlText = readText(sqlPath);
  const feText = readText(feConstantsPath);

  const beMain = parseTSConstant(beText, 'UNLOCK_MAIN_PHOTO_AT');
  const beAll = parseTSConstant(beText, 'UNLOCK_ALL_PHOTOS_AT');
  const feMain = parseTSConstant(feText, 'UNLOCK_MAIN_PHOTO_AT');
  const feAll = parseTSConstant(feText, 'UNLOCK_ALL_PHOTOS_AT');

  // 014 트리거 안의 두 `new_count >= N` 리터럴 (main, all 순서로 등장).
  // 두 마커 사이 거리가 짧으므로 indexOf 두 번 + slice 로 분리 파싱.
  const firstMainIdx = sqlText.indexOf('new_count >= ');
  const sqlMain =
    firstMainIdx >= 0
      ? parseSQLLiteralAfter(sqlText, 'new_count >= ')
      : null;
  const sqlAfterFirst = firstMainIdx >= 0 ? sqlText.slice(firstMainIdx + 'new_count >= '.length + 1) : '';
  const sqlAll = parseSQLLiteralAfter(sqlAfterFirst, 'new_count >= ');

  it('BE constants/chat.ts 가 두 상수를 export 한다', () => {
    expect(beMain, 'UNLOCK_MAIN_PHOTO_AT not found in BE chat.ts').not.toBeNull();
    expect(beAll, 'UNLOCK_ALL_PHOTOS_AT not found in BE chat.ts').not.toBeNull();
  });

  it('FE constants/photoAccess.ts 가 두 상수를 export 한다', () => {
    expect(feMain, 'UNLOCK_MAIN_PHOTO_AT not found in FE photoAccess.ts').not.toBeNull();
    expect(feAll, 'UNLOCK_ALL_PHOTOS_AT not found in FE photoAccess.ts').not.toBeNull();
  });

  it('014 트리거 SQL 이 두 개의 `new_count >= N` 리터럴을 보유한다', () => {
    expect(sqlMain, 'first new_count >= N missing in 014').not.toBeNull();
    expect(sqlAll, 'second new_count >= N missing in 014').not.toBeNull();
  });

  it('UNLOCK_MAIN_PHOTO_AT 가 BE / SQL / FE 3 곳에서 동일하다', () => {
    expect(beMain).toBe(sqlMain);
    expect(beMain).toBe(feMain);
  });

  it('UNLOCK_ALL_PHOTOS_AT 가 BE / SQL / FE 3 곳에서 동일하다', () => {
    expect(beAll).toBe(sqlAll);
    expect(beAll).toBe(feAll);
  });
});
