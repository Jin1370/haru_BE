-- message-reply: 특정 메시지에 답장.
--
-- 인용문을 original_text 에 합성해서 넣지 않고 별도 컬럼으로 참조한다. 본문에
-- 끼워 넣으면 (a) TTS 가 인용문까지 읽어 클론 보이스가 상대 말을 대신 읽고
-- (b) 번역 파이프라인이 인용문을 다시 번역하며 (c) 옛 클라이언트에서 인용이
-- 본문과 섞여 보인다.
--
-- ON DELETE SET NULL — 원본이 사라져도 답장 자체는 남는다 (지금은 메시지를
-- 삭제하는 경로가 없지만, 삭제 기능이 붙어도 답장이 통째로 사라지지 않게).
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS reply_to_id UUID REFERENCES messages(id) ON DELETE SET NULL;
