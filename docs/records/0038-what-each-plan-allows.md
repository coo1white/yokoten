# 0038 What each plan allows for shared work: a survey of vendor terms

Status: proposed; facts to check before layer 3 is offered
Date: 2026-10-23 (UTC)

## Context

The owner agreed the three-layer direction on 2026-10-23 (#755–757):

1. your own machines on one board (#682);
2. a team's idle machines and AI plans on one board;
3. an open network where people lend idle machines and quota to open-source projects.

Layers 2 and 3 put one person's subscription, or its quota, behind another person's
work. Many personal plans allow use by the account holder only. The owner needs to know
which ones before layer 3 is pitched as something people can do today.

This is a list of what each vendor's documents say, and where they are unclear. It is
not legal advice.

## Read this first

No vendor page was read at its source for this record. The desk that wrote it had no
network on 2026-10-23. So each cell comes from the author's knowledge of the documents,
not from a page opened that day. The links are the pages to read. The "Check" line under
each vendor names the clause to find.

Do not offer layer 3 until every row below is read at the source, and the date read is
written next to it.

## The distinction that decides most rows

Two acts look alike and are not:

- **The plan's owner runs the work**, and gives the result away. This is ordinary use.
- **Someone else's work runs on the owner's plan**, so the plan pays for it. This is
  **quota lending**, and it is the act the terms are usually silent about.

Every vendor below is clear that an account belongs to one person. None of the
documents read here says "another person's task may run on your plan".

## Summary

| Vendor | Personal plan | Layer 2: one team | Layer 3: strangers | What the same vendor's API allows instead |
|---|---|---|---|---|
| Anthropic | Claude Free, Pro, Max | Not allowed on one account; one account per person | Not allowed | Pay per token. Use in your own work and products. No resale. A team behind one payer is unclear. |
| xAI | SuperGrok; Grok in X | Not allowed: the account is personal | Not allowed | Pay per token. Commercial use allowed. Shared quota and resale are unclear. |
| OpenCode | OpenCode Go | Unclear: the plan is per person, and the terms do not say | Not allowed | The tool is open source. You bring a provider's key, under that provider's terms. |
| DeepSeek | DeepSeek chat app | Not allowed: no automated use | Not allowed | Pay per token. Commercial use allowed. Resale is unclear. Some regions are not served. |
| OpenAI | ChatGPT Plus, Pro | Not allowed; Business and Enterprise add a seat per person | Not allowed | Pay per token. Use in your own products. No resale, no shared quota. |
| Meta | Meta AI app | Not allowed for the app | Not allowed for the app | Llama weights: host them yourself. Commercial use below 700M monthly users. The most open route. |

## Anthropic

- Documents: Consumer Terms of Service, Commercial Terms of Service, Usage Policy.
  Link: <https://www.anthropic.com/legal>
- What they say: the consumer terms tie one account to one person, and forbid sharing
  credentials. The commercial terms allow building with the API, and forbid reselling it
  or offering it as a substitute for Anthropic's own service.
- Check: the account-sharing clause, then the resale clause.
- Layer 2: not allowed while one Max account serves a team. Each person on their own
  account is fine. A team that pays for one API account itself is probably fine.
- Layer 3: no. Lending a Max account is account sharing; lending API credit to strangers
  looks like resale. Both need Anthropic's written yes.
- Unclear: whether a lead's account may run a teammate's task at all, when the lead
  clicks start. The documents do not name the case.

## xAI

- Documents: Consumer Terms of Service, and the API terms for the developer platform.
  Link: <https://x.ai/legal>
- What they say: the consumer terms make the subscription personal, and forbid account
  sharing and automated scraping. The API terms allow commercial use of the models.
- Check: "share your account", then "resell" or "transfer".
- Layer 2: not allowed on SuperGrok. A team API key paid by the team is the likely route,
  but the terms do not say whether several people may draw on it.
- Layer 3: no on the consumer plan. An API account that lends usage to strangers tests
  the resale clause, which is unclear.
- Unclear: shared quota on one API account.

## OpenCode

- Documents: the plan page for OpenCode Go, and its terms.
  Link: <https://opencode.ai>
- What they say: OpenCode is open source, and the plan sells model access inside it.
  The plan is per person, with usage windows and fair-use limits.
- Check: "per user", "share", "resell", and what a usage window counts.
- Layer 2: unclear. Running your own agents is the point of the plan. A teammate's
  sessions on your plan is not described.
- Layer 3: no. The plan's quota is not a product you may pass on.
- Note: the tool itself may be shared freely. Only the plan's quota is limited. The same
  toolbox with each person's own key has no such question.

## DeepSeek

- Documents: DeepSeek Open Platform Terms of Service, and the chat app's terms.
  Link: <https://platform.deepseek.com>
- What they say: the API is paid per token and may be used in your own products. The
  chat app is personal, and forbids automated access. The platform serves listed regions.
- Check: "resell", "third party", "automated", and the list of supported regions.
- Layer 2: the team's own API account is the likely yes. Personal app use by a teammate
  is not.
- Layer 3: no on the app. Lending API credit is unclear, and likely resale.
- Unclear: region limits make "strangers anywhere" a question even with an API account.

## OpenAI

- Documents: Terms of Use (ChatGPT), Service Terms (API), Sharing and Publication Policy.
  Link: <https://openai.com/policies/>
- What they say: the consumer terms make the account personal, and forbid sharing
  credentials and automated extraction. Business and Enterprise add one seat per person.
  The API terms allow use in your own products, and forbid reselling access.
- Check: "share your account", "resell", "compete".
- Layer 2: not allowed on Plus or Pro. Business seats are the honest route for a team,
  and each seat is one person.
- Layer 3: no. Selling or giving quota to strangers is resale.
- Unclear: whether one API organization may pay for several people's work across
  projects. That is normal business use to most readers, but the record does not say.

## Meta

- Documents: Llama Community License, Acceptable Use Policy; Meta AI terms for the app.
  Link: <https://www.llama.com/legal/>
- What they say: the weights may be hosted and served by you, for commercial use, below
  700 million monthly users. The license asks for the "Built with Llama" naming and a
  copy of the license. The Meta AI app is personal.
- Check: the 700M clause, the naming clause, and the Acceptable Use Policy.
- Layer 2: allowed when the team hosts the weights and keeps the license terms.
- Layer 3: allowed on the same terms. This is the one route where a stranger's work may
  run on another person's machine without a plan in the middle.
- Unclear: whether a network that runs work for many organizations counts as one
  downstream product. If it does, the 700M limit applies to the network, not to each
  project.

## What this means for the direction

- Layer 2 can start today in three cases. Each person runs their own plan. The team pays
  for one API account. The model runs on the team's own hardware.
- Layer 3 has one clean route today: open weights on the lender's machine (Meta, and
  local models). Every subscription route needs a written yes from the vendor.
- The API is the likely route for a team, because the team is one payer with one
  contract. It is not a route for strangers.
- Put the answer on the machine card: "your plan, your work" or "team API". A person
  should never have to read a license to know what a button does.

## How to check, in one pass

1. Open each link and find the clause named above.
2. Search the page for "share", "account", "resell", "third party", "automated".
3. Replace the cell. Write the date read and the clause number beside it.
4. A page that is silent on quota lending leaves the cell "unclear". Silence is not a yes.

## Open questions

- May one team API account pay for several people's work? Four vendors are silent.
- Does a usage window count one person's sessions or an account's total?
- Who is the "user" when an agent acts for a person who did not start it?
- Which vendors answer a written question, and how fast? A yes in writing is worth more
  than a reading of a clause.
