// ============================================
// OpenSwarm - First-run onboarding wizard
// `openswarm init` (interactive). INT-1578.
// ============================================
//
// Walks a fresh user through: AI provider (+ inline auth), task backend
// (Linear or local SQLite), and an optional notification channel. Writes a
// .env (secrets, 0600) + config.yaml, then validates. `--yes` keeps the old
// config-only path for CI (handled by the caller in cli.ts).

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPrompter, type ChoiceOption } from '../support/promptHelper.js';
import { writeEnvVars } from '../core/envFile.js';
import { generateSampleConfig } from '../core/config.js';
import { AuthProfileStore } from '../auth/index.js';

type ProviderId = 'codex-responses' | 'openrouter' | 'gpt' | 'lmstudio' | 'local' | 'codex' | 'claude';
type TaskBackend = 'linear' | 'local';
type NotifyChannel = 'none' | 'discord' | 'slack' | 'telegram' | 'webhook';

const PROVIDER_OPTIONS: ChoiceOption<ProviderId>[] = [
  { label: 'codex-responses', value: 'codex-responses', hint: 'ChatGPT subscription (OAuth) — Codex models, native loop' },
  { label: 'openrouter', value: 'openrouter', hint: 'OpenRouter API key or OAuth (any model)' },
  { label: 'gpt', value: 'gpt', hint: 'OpenAI ChatGPT OAuth (chat/completions)' },
  { label: 'lmstudio', value: 'lmstudio', hint: 'Local LM Studio server (no account)' },
  { label: 'local', value: 'local', hint: 'Local Ollama models (no account)' },
  { label: 'codex', value: 'codex', hint: 'External codex CLI (delegated)' },
  { label: 'claude', value: 'claude', hint: 'Claude Code CLI (`claude -p` headless — uses your Claude subscription)' },
];

const TASK_OPTIONS: ChoiceOption<TaskBackend>[] = [
  { label: 'local', value: 'local', hint: 'Local SQLite issue store (~/.openswarm/issues.db) — no account' },
  { label: 'linear', value: 'linear', hint: 'Linear (paste API key + team id)' },
];

const NOTIFY_OPTIONS: ChoiceOption<NotifyChannel>[] = [
  { label: 'none', value: 'none', hint: 'No outbound notifications' },
  { label: 'discord', value: 'discord', hint: 'Discord bot token + channel id' },
  { label: 'slack', value: 'slack', hint: 'Slack incoming webhook URL' },
  { label: 'telegram', value: 'telegram', hint: 'Telegram bot token + chat id' },
  { label: 'webhook', value: 'webhook', hint: 'Generic webhook URL' },
];

/** ChatGPT-OAuth providers share the openai-gpt profile; openrouter has its own. */
function authPlanFor(provider: ProviderId): { providerArg: 'gpt' | 'openrouter'; profileKey: string } | null {
  if (provider === 'codex-responses' || provider === 'gpt') return { providerArg: 'gpt', profileKey: 'openai-gpt:default' };
  if (provider === 'openrouter') return { providerArg: 'openrouter', profileKey: 'openrouter:default' };
  return null; // lmstudio / local / codex need no OAuth here
}

/** Apply the wizard's choices onto the static sample config via targeted replaces. */
export function buildWizardConfig(adapter: ProviderId, channel: NotifyChannel): string {
  let cfg = generateSampleConfig();
  cfg = cfg.replace(/^adapter: codex$/m, `adapter: ${adapter}`);
  cfg = cfg.replace(/^ {2}channel: discord$/m, `  channel: ${channel === 'none' ? 'none' : channel}`);
  const uncomment = (field: string) => {
    cfg = cfg.replace(`  # ${field}:`, `  ${field}:`);
  };
  if (channel === 'slack') uncomment('slackWebhookUrl');
  if (channel === 'telegram') {
    uncomment('telegramBotToken');
    uncomment('telegramChatId');
  }
  if (channel === 'webhook') uncomment('webhookUrl');
  return cfg;
}

export interface InitWizardOptions {
  force?: boolean;
}

export async function runInitWizard(opts: InitWizardOptions = {}): Promise<void> {
  const configPath = join(process.cwd(), 'config.yaml');
  const envPath = join(process.cwd(), '.env');

  if (existsSync(configPath) && !opts.force) {
    console.error('config.yaml already exists. Use --force to overwrite, or edit it directly.');
    process.exit(1);
  }

  const store = new AuthProfileStore();
  const prompter = createPrompter();
  const envVars: Record<string, string> = {};
  let provider: ProviderId;
  let taskBackend: TaskBackend;
  let notify: NotifyChannel;
  let doAuthNow = false;

  try {
    console.log('OpenSwarm first-run setup — three quick choices.\n');

    // 1) AI provider
    provider = await prompter.choose('1) AI provider for worker/reviewer:', PROVIDER_OPTIONS);
    const plan = authPlanFor(provider);
    if (plan) {
      const already = store.getProfile(plan.profileKey) !== null;
      if (already) {
        console.log(`   ✓ already authenticated (${plan.profileKey}).`);
      } else {
        doAuthNow = await prompter.confirm(`   ${provider} needs login. Run \`auth login --provider ${plan.providerArg}\` now?`, true);
      }
    } else {
      console.log(`   ${provider} needs no OAuth here (configure its endpoint/model later).`);
    }

    // 2) Task backend
    taskBackend = await prompter.choose('\n2) Task backend:', TASK_OPTIONS);
    if (taskBackend === 'linear') {
      console.log('   Get a key at https://linear.app/settings/api');
      const apiKey = await prompter.ask('   LINEAR_API_KEY');
      const teamId = await prompter.ask('   LINEAR_TEAM_ID');
      if (apiKey) envVars.LINEAR_API_KEY = apiKey;
      if (teamId) envVars.LINEAR_TEAM_ID = teamId;
    }

    // 3) Notification channel
    notify = await prompter.choose('\n3) Notification channel (optional):', NOTIFY_OPTIONS);
    if (notify === 'discord') {
      envVars.DISCORD_TOKEN = await prompter.ask('   DISCORD_TOKEN');
      envVars.DISCORD_CHANNEL_ID = await prompter.ask('   DISCORD_CHANNEL_ID');
    } else if (notify === 'slack') {
      envVars.SLACK_WEBHOOK_URL = await prompter.ask('   SLACK_WEBHOOK_URL');
    } else if (notify === 'telegram') {
      envVars.TELEGRAM_BOT_TOKEN = await prompter.ask('   TELEGRAM_BOT_TOKEN');
      envVars.TELEGRAM_CHAT_ID = await prompter.ask('   TELEGRAM_CHAT_ID');
    } else if (notify === 'webhook') {
      envVars.NOTIFY_WEBHOOK_URL = await prompter.ask('   NOTIFY_WEBHOOK_URL');
    }
  } finally {
    prompter.close();
  }

  // Drop empty answers so we never write `KEY=` for a skipped field.
  for (const k of Object.keys(envVars)) {
    if (!envVars[k]) delete envVars[k];
  }

  // Write .env (secrets) + config.yaml.
  if (Object.keys(envVars).length > 0) {
    writeEnvVars(envPath, envVars);
    console.log(`\nWrote ${envPath} (${Object.keys(envVars).join(', ')}) — chmod 600.`);
  }
  writeFileSync(configPath, buildWizardConfig(provider, notify), 'utf-8');
  console.log(`Wrote ${configPath}.`);

  // Inline auth last (browser OAuth) — after the prompt readline is closed.
  const plan = authPlanFor(provider);
  if (doAuthNow && plan) {
    console.log(`\nLaunching login for ${plan.providerArg}...`);
    const { handleAuthLogin } = await import('./authHandler.js');
    await handleAuthLogin(plan.providerArg, {});
  }

  // Next steps.
  console.log('\nNext steps:');
  console.log('  1. Edit config.yaml — set your project path(s) under `agents:`.');
  if (plan && !doAuthNow && store.getProfile(plan.profileKey) === null) {
    console.log(`  2. Authenticate: openswarm auth login --provider ${plan.providerArg}`);
  }
  console.log('  • Validate: openswarm validate');
  console.log('  • Start:    openswarm start   (or `openswarm chat` for the TUI)');
  if (taskBackend === 'local') {
    console.log('  • Task backend: local SQLite (~/.openswarm/issues.db) — no Linear account needed.');
  }
}
