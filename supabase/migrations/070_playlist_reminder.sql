-- 070_playlist_reminder.sql
-- 그날 플레이리스트를 아직 안 연 사용자에게 현지 저녁 8시에 알림 (jobs/remindPlaylist.ts).
--
-- user_preferences.notify_playlist = 알림 설정의 "플레이리스트 알림" 토글 (기본 ON).
-- profiles.playlist_reminder_on    = 마지막으로 보낸 현지 날짜. 하루 1회 보장 + 서버 여러 대가
--                                    같은 시각에 돌아도 한쪽만 보내는 claim 용도.

ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS notify_playlist BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS playlist_reminder_on DATE;
