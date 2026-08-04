// Storage 고아 스캔/정리. 계정·메시지가 이미 사라져 소유자를 특정할 수 없는
// 잔존 파일을 찾는다 (정상 삭제 경로는 services/storage.ts 의 purgeUser* 가 담당).
//
// 사용:
//   npx tsx scripts/orphan-scan.ts            # 스캔만 (읽기 전용, 기본)
//   npx tsx scripts/orphan-scan.ts --delete   # 실제 삭제
//
// 대상 DB = .env 의 SUPABASE_URL. prod 를 정리하려면 prod 값으로 실행할 것.
//
// 업로드 직후 race 회피: 24시간 이내에 만들어진 파일은 건드리지 않는다
// (메시지 파이프라인은 Storage 업로드 후 DB INSERT 라 그 사이엔 정상 파일도
// "행 없는 파일" 로 보인다).

import 'dotenv/config';
import { supabase } from '../src/config/supabase';
import { purgeUserFolders } from '../src/services/storage';

const DELETE = process.argv.includes('--delete');
const MIN_AGE_MS = 24 * 60 * 60 * 1000;

async function main() {
  console.log(`URL: ${process.env.SUPABASE_URL}`);
  console.log(DELETE ? '** DELETE 모드 **\n' : '(스캔만 — 삭제하려면 --delete)\n');

  // ── 계정 폴더 (photos / voice-intro-audio) ──
  const ids = new Set<string>();
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    data.users.forEach((u) => ids.add(u.id));
    if (data.users.length < 1000) break;
  }
  console.log(`auth.users: ${ids.size}`);

  const orphanUsers = new Set<string>();
  for (const bucket of ['photos', 'voice-intro-audio']) {
    const { data, error } = await supabase.storage.from(bucket).list('', { limit: 1000 });
    if (error) {
      console.error(`${bucket}: ${error.message}`);
      continue;
    }
    const folders = (data ?? []).map((f) => f.name).filter((n) => !n.startsWith('.'));
    const orphans = folders.filter((f) => !ids.has(f));
    orphans.forEach((o) => orphanUsers.add(o));
    console.log(`${bucket}: ${folders.length} folders, orphan ${orphans.length}`);
    orphans.forEach((o) => console.log(`   ${o}`));
  }

  if (DELETE && orphanUsers.size > 0) {
    let n = 0;
    for (const userId of orphanUsers) {
      try {
        n += await purgeUserFolders(userId);
      } catch (e) {
        console.error(`   ${userId} 실패: ${(e as Error).message}`);
      }
    }
    console.log(`→ 계정 폴더 ${n} files removed`);
  }

  // ── voice-messages (평면 {messageId}.mp3) ──
  const files: { name: string; created_at?: string }[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.storage
      .from('voice-messages')
      .list('', { limit: 1000, offset });
    if (error) {
      console.error(`voice-messages: ${error.message}`);
      return;
    }
    const batch = (data ?? []).filter((f) => f.name.endsWith('.mp3'));
    files.push(...batch);
    if ((data ?? []).length < 1000) break;
  }

  const cutoff = Date.now() - MIN_AGE_MS;
  const recent = files.filter((f) => f.created_at && new Date(f.created_at).getTime() > cutoff);
  const aged = files.filter((f) => !recent.includes(f));

  // `{id}.mp3` 와 `{id}_v{ts}.mp3` 는 같은 메시지 — 한 쪽이라도 살아있으면 보존.
  const msgIdOf = (name: string) => name.replace(/(_v\d+)?\.mp3$/, '');
  const msgIds = [...new Set(aged.map((f) => msgIdOf(f.name)))];

  const alive = new Set<string>();
  // 청크 100 — UUID 100개면 쿼리스트링 ~4KB. 500 은 URL 길이 상한에 걸려
  // "fetch failed" 로 떨어진다 (prod 실측).
  for (let i = 0; i < msgIds.length; i += 100) {
    const { data, error } = await supabase
      .from('messages')
      .select('id')
      .in('id', msgIds.slice(i, i + 100));
    if (error) {
      console.error(`messages 조회 실패: ${error.message}`);
      return;
    }
    (data ?? []).forEach((r) => alive.add(r.id as string));
  }

  const deadFiles = aged.filter((f) => !alive.has(msgIdOf(f.name))).map((f) => f.name);
  console.log(
    `\nvoice-messages: ${files.length} files (최근 24h 제외 ${recent.length}), 고아 ${deadFiles.length}`,
  );

  if (DELETE && deadFiles.length > 0) {
    let removed = 0;
    for (let i = 0; i < deadFiles.length; i += 100) {
      const chunk = deadFiles.slice(i, i + 100);
      const { error } = await supabase.storage.from('voice-messages').remove(chunk);
      if (error) console.error(`   remove 실패: ${error.message}`);
      else removed += chunk.length;
    }
    console.log(`→ voice-messages ${removed} files removed`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
