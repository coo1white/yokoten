# 0033 A hard spending limit for agents

Status: accepted
Date: 2026-10-23 (UTC)

## Context

Agents can now pay for a call by themselves. x402 and similar schemes answer an HTTP
request with a price, and the agent pays it per call. The owner wants the agent to work
without handing over the whole wallet.

The OpenAI and METR/Redwood reports on the July 2026 Hugging Face incident show agents
under pressure going around rules (record 0019). Money needs a limit the agent cannot
raise by itself, and a record of every payment.

A fresh web search was not possible from this desk: its network is for the model only.
The design therefore follows the shape of x402, which the report describes, and stays
neutral about the scheme. The first check after merge should measure how widely these
schemes are used (issue #640).

## Decision

1. **A payment** is one outgoing amount for one paid call or download. A failed attempt
   is kept as an attempt, and is not counted against the day. A subscription or a monthly
   bill is not a payment here; it needs its own record.
2. **The limit** is at most an amount a day, at most an amount a payment, and only to the
   services the owner names. A day is a UTC day, as every time in yokoten is (record 0027).
3. **The limit lives outside every repo**, in `~/.config/yokoten/spending.json`. A worker
   cannot change that folder: the tool-call guard already refuses its writes there. The
   command also refuses to change the limit while the worker role is set.
4. **The owner sets the limit.** `yokoten spend limit` prints the new limit and writes it
   only with `--yes`. Raising a cap or adding a service counts as a new permission, so it
   needs `--yes`. Lowering a cap, or `spend off`, is safe and needs no flag.
5. **An agent asks before it pays.** `yokoten spend check` says pay or ask. `yokoten spend
   pay -- <command>` checks first, runs the command only inside the limit, and adds the
   payment to `~/.config/yokoten/payments.jsonl`. Over the limit it prints the reason and
   runs nothing. The command after `--` passes the same tool-call guard as any other call,
   so `pay` is not a tunnel around the worker rules.
6. **The wallet stays the hard lock.** yokoten never stores a key. The owner funds a
   small balance, so the money there is the ceiling that no edit to yokoten can raise.
   yokoten's limit is the guard on the path its agents use, and the board makes a bypass
   visible.
7. **The board shows every payment of the day**: time, amount, service, and paid or
   failed. It also shows the limit, the total paid today, and what is left. The plain
   text board shows this first; the page follows in a later change.
8. **A limit that cannot be read stops payments.** Missing means none is set: an agent
   pays nothing and asks the owner. Broken means the same, with the reason.

## Tiers and ways back (record 0014)

| Action | Tier | Way back |
|---|---|---|
| `spend status`, `spend check` | Do by default | None needed: it reads, and writes nothing |
| `spend pay` inside the limit | Do by default | `spend off` removes the limit, and then nothing is paid |
| Lower a cap; `spend off` | Do by default | Run `spend limit ... --yes` again |
| Set or raise a limit; add a service | Ask first: prints the change, writes only with `--yes` | `spend off`, or set a lower cap |
| Change the limit as a worker | Never | The owner changes it from the lead's clone |
| Read a broken limit file as "fine" | Never: it refuses | Fix the file, or set it again |

`spend off` removes the limit file. With no file, an agent pays nothing, so off is the
safe direction. The payments log stays, because what was paid is history.

## Amounts

Amounts are kept in micro-dollars, an integer, so `0.10 + 0.20` is exactly `0.30` and a
day cap is never passed by rounding. A payment names at most 6 decimals. The limit file
keeps amounts as text (`"2.00"`, `"0.10"`) so a person can read it.

A service is a host name, compared without case. A rule that starts with `*.` matches a
subdomain, never the bare domain.

## Options not taken

- **Pay from a yokoten wallet.** yokoten would hold a key, and a bug in yokoten would
  hold the money. The owner's wallet stays the lock.
- **A limit in `yokoten.json`.** A worker can read it, but the repo would carry a price
  list, and a merge could raise it.
- **A question on every payment.** It trains the owner to press yes, and a run with no
  terminal cannot answer.
- **Only a daily cap.** One big payment could take the whole day. The per-payment cap and
  the service list cost the same and say more.
- **Refuse every unknown service silently.** The agent would stop without a sentence the
  owner can act on. It stops, names the service and the limit, and asks.

## Consequences

- `yokoten spend` is a new command, with `status`, `check`, `pay`, `limit` and `off`.
- A new request stays inside the limit only if the agent uses `spend pay`. An agent that
  pays another way is outside the ledger, and the owner sees a gap. The later fix is a
  guard on the known payment clients, when their names are known.
- The page shows payments after a later change; `board --text` shows them now.
- Every limit change keeps its `setAt` time, so the board can say when it last changed.
