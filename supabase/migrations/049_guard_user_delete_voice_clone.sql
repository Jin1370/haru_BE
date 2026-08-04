-- 보이스 클론이 남아있는 계정의 하드 삭제 차단.
--
-- 배경: Dashboard(Authentication → Users → Delete)에서 계정을 지우면 auth.users
-- 행만 사라지고 CASCADE 로 profiles 가 따라 지워진다. ElevenLabs 서버의 보이스
-- 클론은 그대로 남는데, voice_id 를 들고 있던 profiles 행이 이미 없어져서
-- 나중에 지울 방법이 사라진다(복구 불가 고아).
--
-- 이 트리거는 elevenlabs_voice_id 가 아직 채워져 있는 계정의 DELETE 를 거부한다.
-- 정상 삭제 경로(scripts/delete-user.ts, cleanup-dev-accounts.ts)는 클론을 먼저
-- 지우고 컬럼을 NULL 로 비우므로 통과한다. 앱 내 회원탈퇴는 auth.users 를 삭제
-- 하지 않고 anonymize 만 하므로 영향 없음.
--
-- SECURITY DEFINER: 트리거는 supabase_auth_admin 권한으로 실행되는데 이 롤은
-- public.profiles 읽기 권한이 없다.

CREATE OR REPLACE FUNCTION public.guard_user_delete_voice_clone()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_voice_id TEXT;
BEGIN
  SELECT elevenlabs_voice_id INTO v_voice_id
  FROM public.profiles
  WHERE id = OLD.id;

  IF v_voice_id IS NOT NULL THEN
    RAISE EXCEPTION
      'user % still has an ElevenLabs voice clone (%). Use: npx tsx scripts/delete-user.ts %',
      OLD.id, v_voice_id, OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS guard_user_delete_voice_clone ON auth.users;
CREATE TRIGGER guard_user_delete_voice_clone
  BEFORE DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.guard_user_delete_voice_clone();
