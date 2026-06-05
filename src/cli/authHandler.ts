// ============================================
// OpenSwarm - Auth CLI Handler
// `openswarm auth login/status/logout`
// ============================================

import { AuthProfileStore } from '../auth/index.js';
import { loginAndSaveProfile } from '../auth/oauthPkce.js';

const DEFAULT_CLIENT_ID = process.env.OPENAI_CLIENT_ID ?? '';

/**
 * GPT OAuth 로그인 흐름 실행
 */
export async function handleAuthLogin(provider: string, opts: { clientId?: string; port?: number }): Promise<void> {
  if (provider !== 'gpt') {
    console.error(`지원하지 않는 provider: "${provider}". 현재 "gpt"만 지원합니다.`);
    process.exit(1);
  }

  const clientId = opts.clientId ?? DEFAULT_CLIENT_ID;
  if (!clientId) {
    console.error('OpenAI Client ID가 필요합니다.');
    console.error('환경변수 OPENAI_CLIENT_ID를 설정하거나 --client-id 옵션을 사용하세요.');
    console.error('');
    console.error('  export OPENAI_CLIENT_ID="your-client-id"');
    console.error('  openswarm auth login --provider gpt');
    console.error('');
    console.error('또는:');
    console.error('  openswarm auth login --provider gpt --client-id "your-client-id"');
    process.exit(1);
  }

  try {
    await loginAndSaveProfile(clientId, opts.port);
    console.log('');
    console.log('GPT 어댑터를 사용하려면 config.yaml에서 adapter를 변경하세요:');
    console.log('  adapter: gpt');
    console.log('');
    console.log('또는 CLI에서 직접 실행:');
    console.log('  openswarm run "your task" --model gpt-4o');
  } catch (err) {
    console.error(`OAuth 로그인 실패: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * 저장된 인증 프로필 상태 표시
 */
export function handleAuthStatus(): void {
  const store = new AuthProfileStore();
  const profiles = store.listProfiles();
  const keys = Object.keys(profiles);

  if (keys.length === 0) {
    console.log('저장된 인증 프로필이 없습니다.');
    console.log('로그인: openswarm auth login --provider gpt');
    return;
  }

  console.log('인증 프로필:');
  console.log('');

  for (const key of keys) {
    const p = profiles[key];
    const expired = Date.now() > p.expires;
    const expiresAt = new Date(p.expires).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    const status = expired ? '만료됨' : '유효';

    console.log(`  ${key}`);
    console.log(`    Provider:   ${p.provider}`);
    console.log(`    Token:      ${maskToken(p.access)}`);
    console.log(`    Expires:    ${expiresAt} (${status})`);
    if (p.accountId) {
      console.log(`    Account:    ${p.accountId}`);
    }
    console.log('');
  }
}

/**
 * 인증 프로필 삭제
 */
export function handleAuthLogout(provider: string): void {
  if (provider !== 'gpt') {
    console.error(`지원하지 않는 provider: "${provider}". 현재 "gpt"만 지원합니다.`);
    process.exit(1);
  }

  const profileKey = 'openai-gpt:default';
  const store = new AuthProfileStore();

  if (store.deleteProfile(profileKey)) {
    console.log(`프로필 "${profileKey}" 삭제 완료.`);
  } else {
    console.log(`프로필 "${profileKey}"이(가) 존재하지 않습니다.`);
  }
}

function maskToken(token: string): string {
  if (token.length <= 8) return '****';
  return token.slice(0, 4) + '...' + token.slice(-4);
}
