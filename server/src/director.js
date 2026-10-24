import { AgenticOrg } from 'agenticorg-sdk';
import { config } from './config.js';

// The AI director is an agent in the AgenticOrg workspace, run by its agent ID.
// It suggests ideas; Claude writes the scripts and the notes on takes (see claude.js).
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
  suggest_ideas: 'JSON: { ideas: [{ title, format, why }] } with 4-6 ideas',
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

// The creator's gender is passed so Hindi lines use the right verb forms
// ("main karti hoon" / "main karta hoon").
const creatorInputs = (creator) => ({
  creator_name: creator.name,
  creator_niche: creator.niche,
  creator_gender: creator.gender,
});

export function suggestIdeas({ creator, language }) {
  return ask('suggest_ideas', { ...creatorInputs(creator), language: language || 'Hinglish' });
}
