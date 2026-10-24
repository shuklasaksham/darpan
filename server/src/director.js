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
      timeout: 60_000,
    })
  : null;

export const directorConfigured = Boolean(client && config.agenticorgDirectorAgentId);

export class DirectorError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// Hinglish means Roman script; agents otherwise tend to drift into Devanagari.
const SCRIPT = {
  Hinglish: 'Write in Hinglish using Roman (English) letters only, no Devanagari.',
  Hindi: 'Write in Hindi using Devanagari.',
  English: 'Write in simple Indian English.',
};
const scriptRule = (language) => SCRIPT[language] ?? SCRIPT.Hinglish;

const TASKS = {
  review_script: (i) =>
    `Review this reel script for a first-time Indian creator (niche: ${i.creator_niche}, language: ${i.language}) and reply only with JSON { "notes": [up to 3 short, specific suggestions] }. ${scriptRule(i.language)} Script: ${JSON.stringify(i.script)}`,
  suggest_ideas: (i) =>
    `Suggest 4-6 reel ideas for a first-time Indian creator in the niche "${i.creator_niche}", in ${i.language}. ${scriptRule(i.language)} Reply only with JSON { "ideas": [{ "title", "format", "why" }] }.`,
};

const OUTPUT_FORMATS = {
  suggest_ideas: 'JSON: { ideas: [{ title, format, why }] } with 4-6 ideas',
  review_script: 'JSON: { notes: [string] } with at most 3 short, specific suggestions to make the reel land better',
};

async function ask(action, inputs) {
  if (!directorConfigured) {
    throw new DirectorError('The AI director is not configured', 503);
  }
  let result;
  try {
    result = await client.agents.run(config.agenticorgDirectorAgentId, {
      action,
      // Chat-style AgenticOrg agents read `task`; the structured fields ride along.
      inputs: { task: TASKS[action](inputs), ...inputs },
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

/** The director's review of Claude's script, shown before shooting. */
export async function reviewScript({ creator, script, language }) {
  const { notes } = await ask('review_script', { ...creatorInputs(creator), language: language || 'Hinglish', script });
  return Array.isArray(notes) ? notes.filter((n) => typeof n === 'string').slice(0, 3) : [];
}

export function suggestIdeas({ creator, language }) {
  return ask('suggest_ideas', { ...creatorInputs(creator), language: language || 'Hinglish' });
}
