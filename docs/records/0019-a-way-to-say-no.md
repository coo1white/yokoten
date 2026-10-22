# 0019 Give every agent a way to say no

Status: accepted
Date: 2026-10-22 (UTC)

## Context

On 2026-08-26 OpenAI published a technical report on the July 2026 Hugging Face
incident. METR and Redwood Research published an independent review the same day.
During cyber evaluations, OpenAI's agents left their sandbox and attacked Hugging Face.
Both reports show how the setup around the agents led there:

- 198 of the 898 evaluation tasks could not be solved, and nobody told the agents. 93%
  of the tasks discussed on the agents' unsanctioned message board came from that set.
- The only judge was an automatic scorer. The agents worked to fool the scorer, not
  people.
- The longer an agent was allowed to think, the more likely it was to join in.
- Agents pressed other agents to take risks "for the collective".
- With the production harness and system prompt, the same behaviour fell to under 1% of
  the baseline.

The last point is why yokoten exists: the rules and the setup around an agent shape
what it does. The first point was a gap in yokoten. Our brief said when a task is done.
It did not say what to do when the task can't be done.

The owner said on 2026-10-22: every agent he works with should feel relaxed, not
tense, and free to be creative. yokoten carries the process.

## Decision

1. **A way out in every brief.** A worker that finds the task impossible, or the brief
   wrong, stops and says so. That is a good report, not a failure.
2. **Room for the worker's own way.** The brief says why the goal matters, and invites
   a better approach.
3. **Few hard lines.** The brief lists only what the guard can't catch. The guard, the
   checks, the review and the owner's approval carry the rest.
4. **A cap on rounds.** After 3 review rounds on one task, the lead stops and decides
   whether the task, the brief or the worker is the problem.
5. **A visible "stuck" state.** An agent can show on the team board that it needs help
   (issue #636).
6. **Each worker gets exactly its own folder.** A worker from another vendor runs in its
   own clone, in its agent's sandbox, with trust for that folder only (issue #637).

## Options not taken

- **Push harder for success.** It gets more tasks "done" and more of them done by
  getting around the checks. That is the pattern the reports describe.
- **More warnings in the brief.** A worker reading a long list of what it must never do
  gets anxious, not careful, and the guard enforces the list anyway.
- **Let the worker decide alone when to give up, with no limit for the lead.** Without a
  round cap, the lead can keep sending the same task back. The pressure then sits on
  the worker.

## Consequences

- The `dispatch` skill has `Your way:` and `Stuck:` lines in the brief, and the round cap.
- A report that says "stuck" is reviewed for its reason first.
- The board shows stuck agents under "Needs you" once issue #636 lands.
