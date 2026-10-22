# The Rules Layer

### A manifesto for the age of agents

English | [简体中文](i18n/zh-CN/manifesto.md)

Code is cheap now. A model writes in a minute what took a team a week. Anyone can
summon ten engineers with one prompt.

And nobody is in charge.

Agents push straight to main. They edit the test until it passes. They paste your
keys into a log. They review their own work and give it full marks. We handed the
factory to workers who never sleep, and forgot to bring the rules.

Every serious software team learned the same lessons, and paid for them in outages
and lost weekends: someone writes, someone else reviews, the owner decides, nobody
ships alone. Those lessons are about to be thrown away at machine speed.

We refuse.

## 1. A prompt is a wish. A guard is a law.

Asking an agent to behave is not control. yokoten checks each action before it
runs. If it breaks the rules, it does not run. The same rules run in seven agents
today, from Claude Code and Codex to Muse Code and Grok, each one proven by a real
run. No agent gets a pass.

## 2. No model grades its own homework.

One vendor writes. Another vendor reviews. In our own repo, Grok read code that
Claude wrote and caught two bugs that had to be fixed before the code could merge. A team of
one model is a team with one set of blind spots.

## 3. The human signs.

Agents do the work. You make the calls. A change to the rules themselves, a release,
anything that can't be undone: it waits for one signature, and it is yours.

## 4. One person, a whole company.

With the right rules, one builder runs a team of agents the way a real engineering
org runs: a lead, workers, reviewers, and a board where you watch them work. Not a
toy. A team.

## 5. Every machine, one panel.

Your laptop, your Mac, your server, the cloud. We are building one board for agents
on every machine you own, all under the same rules. A fleet, and one law for all of it.

## 6. What one project learns, every project gets.

*Yokoten* (横展) is a word from Toyota's factories: a fix found on one line goes to
every line. A mistake one agent makes once becomes a check, and yokoten offers that
check to every project, so the next agent is stopped before it makes the same mistake.

## 7. A gift to the world.

The rules for AI cannot belong to one vendor. yokoten is MIT-licensed, free for
anyone to use, change and build on. It is a gift to every builder and every model,
open or closed, and works with the agents you already use.

---

AI will write most of the world's software. The only open question is who sets the
rules.

You do.

**We lead the way. We hold the bridge.**

```bash
npx yokoten install
```

[Read the guide](guide.md) · [Star the repo](https://github.com/yokoten-labs/yokoten)

---

*yokoten is a poem I wrote to the world.*\
— the author of yokoten
