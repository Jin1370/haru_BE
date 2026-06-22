// LAUNCH_CHECKLIST #5 — 동의 정책 버전 (단일 진실 소스).
//
// 가입 동의를 기록할 때 profiles.consent_policy_version 에 함께 저장한다. 약관·
// 처리방침을 실질적으로 개정해 재동의를 받아야 할 때 이 값을 올린다 (그 시점에
// 재동의 흐름을 붙이는 건 별도 작업). FE 는 버전을 보내지 않고 BE 가 기록 시점에
// 이 상수를 stamp 하므로 FE/BE 버전 drift 가 발생하지 않는다.
export const CONSENT_POLICY_VERSION = '2026-06-22';
