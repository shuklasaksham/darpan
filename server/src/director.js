import { AgenticOrg } from 'agenticorg-sdk';
import { config } from './config.js';

// The AI director is an agent in the AgenticOrg workspace, run by its agent ID.
// Every call sends an `action` plus inputs; the agent's brief (see README)
// tells it what each action should return.
const client = config.agenticorgApiKey
  ? new AgenticOrg({
      apiKey: config.agenticorgApiKey,
      baseUrl: config.agenticorgBaseUrl,
      timeout: 45_000,
    })
  : null;

export const directorConfigured = Boolean(client && config.agenticorgDirectorAgentId);

export class DirectorError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const OUTPUT_FORMATS = {
  plan_shoot:
    'JSON: { title, hook, shots: [{ title, framing, duration_seconds, say, tips: [string] }], caption, hashtags: [string] }',
  recommend_shot:
    'JSON: { shot: { title, framing, duration_seconds, say, tips: [string] }, why }',
  review_take:
    'JSON: { verdict: "keep" | "retake", praise: [string], fixes: [string], next_step }',
};

async function ask(action, inputs) {
  if (!directorConfigured) {
    throw new DirectorError('The AI director is not configured', 503);
  }
  let result;
  try {
    result = await client.agents.run(config.agenticorgDirectorAgentId, {
      action,
      inputs,
      context: {
        app: 'darpan',
        audience: 'first-time Indian creators shooting vertical reels on a phone',
        output_format: OUTPUT_FORMATS[action],
      },
    });
  } catch (err) {
    console.error('AgenticOrg call failed:', err.message);
    throw new DirectorError('The AI director is unavailable right now');
  }
  if (result.status !== 'completed') {
    console.error('AgenticOrg run not completed:', result.status, result.error, result.hitl_trigger);
    throw new DirectorError(`The AI director could not finish (${result.status})`);
  }
  return { runId: result.run_id, confidence: result.confidence, ...result.output };
}

export function planShoot({ idea, language, durationSeconds, niche }) {
  return ask('plan_shoot', {
    idea,
    language: language || 'Hinglish',
    target_duration_seconds: durationSeconds || 30,
    niche,
  });
}

export function recommendShot({ plan, shotsDone, situation }) {
  return ask('recommend_shot', { plan, shots_done: shotsDone, situation });
}

export function reviewTake({ shot, take }) {
  return ask('review_take', { shot, take });
}
