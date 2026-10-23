// The words the merge record and the merge skill must keep (#488).
// A merge made the yokoten way goes through the bot, and the new commit stays on UTC.
// The zone value is never pasted. Doctor's count of old commits is still open.

/** Phrases the record and the skill share. The command lives in the skill. */
const MERGE_PHRASES = ['Time-Zone', 'not UTC', 'yokoten bot -- gh pr merge --squash'] as const;

/** The skill line that keeps a zone value out of a report. */
const SKILL_PHRASE = 'Do not paste that line';

/**
 * Phrases missing from the record and the skill.
 * Empty when both still say how a merge stays on UTC.
 */
export function missingUtcMergePhrases(record: string, skill: string): string[] {
  const both = `${record}\n${skill}`;
  const missing: string[] = MERGE_PHRASES.filter((phrase) => !both.includes(phrase));
  if (!skill.includes(SKILL_PHRASE)) missing.push(SKILL_PHRASE);
  return missing;
}
