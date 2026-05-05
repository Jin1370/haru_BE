-- 신고 카테고리 확장:
--   underage             — 미성년자 의심 (즉시 운영자 검토 필요)
--   voice_impersonation  — 보이스 도용/악용 (haru 도메인 특화)

ALTER TABLE reports DROP CONSTRAINT reports_reason_check;

ALTER TABLE reports ADD CONSTRAINT reports_reason_check
  CHECK (reason IN (
    'spam',
    'inappropriate',
    'fake_profile',
    'harassment',
    'underage',
    'voice_impersonation',
    'other'
  ));
