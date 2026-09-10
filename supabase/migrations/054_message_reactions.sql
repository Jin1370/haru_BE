-- message-reactions: 상대 메시지에 남기는 단일 리액션.
--
-- 1:1 대화라 리액션 주체는 항상 "발신자가 아닌 쪽" 한 명이다 → 메시지당 0 또는
-- 1개. 별도 테이블도, 작성자 컬럼도 필요 없다 (누가 남겼는지는 sender_id 의
-- 반대편으로 자동 결정된다).
--
-- 이모지 글리프가 아니라 슬러그로 저장한다 — 표시 이모지를 바꿀 때 마이그레이션
-- 없이 FE 상수만 고치면 되게.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reaction TEXT;

-- 컬럼이 이미 있는 환경에서도 CHECK 가 붙도록 제약은 분리해서 재생성.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_reaction_check;
ALTER TABLE messages ADD CONSTRAINT messages_reaction_check
  CHECK (reaction IS NULL OR reaction IN ('heart', 'thumbsup', 'laugh', 'wow', 'sad'));
