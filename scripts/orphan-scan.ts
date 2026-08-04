// Storage 고아 스캔 (읽기 전용). 삭제된 계정/메시지의 잔존 파일을 센다.
// 사용: npx tsx scripts/orphan-scan.ts   (대상 DB = .env 의 SUPABASE_URL)
import 'dotenv/config';
import { supabase } from '../src/config/supabase';

async function main() {
  console.log('URL:', process.env.SUPABASE_URL);

  const ids = new Set<string>();
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    data.users.forEach((u) => ids.add(u.id));
    if (data.users.length < 1000) break;
  }
  console.log(`auth.users: ${ids.size}`);

  for (const bucket of ['photos', 'voice-intro-audio']) {
    const { data, error } = await supabase.storage.from(bucket).list('', { limit: 1000 });
    if (error) { console.error(bucket, error.message); continue; }
    const folders = (data ?? []).map((f) => f.name);
    const orphans = folders.filter((f) => !ids.has(f));
    console.log(`\n${bucket}: ${folders.length} folders, orphan ${orphans.length}`);
    orphans.forEach((o) => console.log('  ', o));
  }

  const { data: vm, error: vmErr } = await supabase.storage
    .from('voice-messages')
    .list('', { limit: 1000 });
  if (vmErr) { console.error('voice-messages', vmErr.message); return; }
  const files = (vm ?? []).filter((f) => f.name.endsWith('.mp3'));
  const msgIds = [...new Set(files.map((f) => f.name.replace(/(_v\d+)?\.mp3$/, '')))];
  const { data: rows, error: rErr } = await supabase
    .from('messages')
    .select('id')
    .in('id', msgIds);
  if (rErr) { console.error(rErr.message); return; }
  const alive = new Set((rows ?? []).map((r) => r.id));
  const dead = msgIds.filter((m) => !alive.has(m));
  console.log(`\nvoice-messages: ${files.length} files / ${msgIds.length} msgIds, DB 없는 것 ${dead.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
