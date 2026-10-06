# Countersign app design

**Status: DRAFT for Afshal's review, 6 Oct 2026.** Written by Claude while Sophie is busy; she can change anything when she is free. No screen is built until this is approved. Covers the web app (phone first, works on a laptop) and the demo supplier portal. Architecture: [`00-architecture.md`](00-architecture.md) v3, decision D20.

## What the app is for

A business pays its suppliers in USDC on Monad, and an AI agent prepares the payments. Countersign checks every one against what the business approved. The app is where a person sees those checks and decides the few that need them, mostly on a phone.

Three jobs, in order:

1. **Show the difference.** When an invoice disagrees with the approved order, show exactly where, so a person can decide in seconds.
2. **Show the volume.** Hundreds of invoices are checked and paid while you watch; held ones stand out.
3. **Prove it.** Every payment has its evidence and its Monad transaction.

Everything else stays quiet.

## The idea: two copies that must line up

"Countersign" means a second signature on a document. Business paperwork has always worked in copies: the order and the invoice, the carbon copy, the cheque and its stub. A clerk checks that the copies agree.

The app is built on that picture. **Every payment is two copies: the approved order and the invoice.** Where they agree, they sit exactly on top of each other. Where they disagree, the copy is out of register, like a misaligned print, and that is the thing your eye goes to.

This is the one bold element. Everything around it is calm, plain and dense.

## Tokens

### Colour

Light mode is the paper of a cheque: a cool, slightly green security-paper tint, with ink in deep blue-black. Dark mode is the same ledger at night, navy rather than black.

| Name | Light | Dark | Use |
|---|---|---|---|
| Paper | `#EEF2EF` | `#0F1724` | Page background |
| Sheet | `#FAFBF9` | `#172133` | Raised surfaces: sheets, rows |
| Ink | `#18233D` | `#E3E9E5` | Text, the approved copy, primary buttons |
| Guide | `#C6D0CB` | `#2A3649` | Rules, outlines, empty tiles |
| Cleared | `#1D6B57` | `#4FB596` | Paid and final |
| Held | `#9A5B00` | `#E0A23A` | Needs a person. Attention, not alarm |
| Refused | `#A3241B` | `#F07A6E` | Refused or blocked |

Rules:
- Colour never carries meaning alone. Held tiles are notched; differing characters are offset and underlined; every state has a word.
- No gradients, no tinted shadows, no decorative colour. One elevation (sheets over paper) with a 1px Guide outline, not a shadow.
- Amounts in Ink. A held amount is not red; only what is over tolerance is marked.

### Type

| Role | Face | Why |
|---|---|---|
| Interface and numbers | **Schibsted Grotesk** (Google Fonts), tabular figures on for amounts | A sturdy grotesk made for dense information, with honest numerals; not the default SaaS face |
| Addresses, invoice numbers, transaction hashes | **Martian Mono** (Google Fonts) | Only where character-by-character comparison is the job. A wide mono makes `0x8f3a…` and `0x8f3e…` readable apart |

Scale (phone, 16px base; laptop steps up one size): 13 / 15 / 16 / 20 / 26 / 34. Body line-height 1.45; headings 1.15. Weights 400 and 600, plus 700 for the run board's counts. Sentence case everywhere. No all-caps labels, no labels above headings, no highlighting a single word.

### Space and shape

- 4px grid; phone gutters 16px; tap targets at least 48px.
- Radius follows hierarchy: sheets 16px, rows 10px, buttons 12px, tiles 3px. Not one radius on everything.
- Primary actions sit in a bottom bar within thumb reach on phones.

### Motion

Only in answer to something:
- **A tile fills** when its payment is checked (run board).
- **The copies come into register** when a person approves: the offset characters slide into place, then the sheet closes.
- **The sheet rises** from the bottom when opened.

No entrance animations, no hover effects on every card. `prefers-reduced-motion` turns all three into instant changes.

## Navigation

Phone: four tabs at the bottom. Laptop: the same four as a left rail, with a list on the left and the open item on the right.

```
┌──────────────────────────────┐
│                              │
│         (screen)             │
│                              │
├───────┬───────┬───────┬──────┤
│ Runs  │ Inbox │Payments│Suppl.│   Inbox shows a count when something waits
└───────┴───────┴───────┴──────┘
```

## Screens

### 1. Approval sheet (the centrepiece)

Opens from the inbox, a run or a notification. One held payment per sheet.

```
┌──────────────────────────────┐
│ Kalibre Studio · Invoice 0142│   supplier, invoice
│ 4,200.00 USDC                │
│                              │
│ The pay-to address changed   │   the finding, in words
│ 4 characters differ          │
│                              │
│ On file                      │
│ 0x8f3a 91c2 77d0 …… 4b1e     │   Martian Mono, grouped in fours
│ On the invoice               │
│ 0x8f3e 91c2 77d6 …… 4b1a     │   differing characters shifted down
│     ‾          ‾        ‾    │   and underlined, in Held
│                              │
│ The supplier's own website   │   evidence, one line each
│ still lists the address on   │
│ file.                        │
│ Invoice says: "We have       │
│ changed our payment details" │
│                              │
├──────────────────────────────┤
│ [ Refuse ]  [ Approve with   │   bottom bar
│              Face ID ]       │
└──────────────────────────────┘
```

- **The finding comes first in words**, then the two copies. Other findings use the same pattern: an added line shows the order's lines and the invoice's lines with the extra one out of register; an amount over tolerance shows both totals and the difference.
- **Long addresses are grouped in fours** and the middle is collapsed only where it matches; any differing group is always shown.
- **The approve button names the device's own unlock:** "Approve with Face ID", "Approve with fingerprint", "Approve with Touch ID", or "Approve with screen lock". The same for Refuse when a signature is needed.
- **Refuse is the safer action** and sits on the left, equal in size; approving a changed address takes a second tap ("Pay the new address anyway").
- After a decision: "Refused. The agent's run has stopped." or "Approved. Paid 4,200.00 USDC, final on Monad." with the transaction link.

### 2. Payment run board

What it looks like when an agent hands over a month-end run.

```
┌──────────────────────────────┐
│ Run of 200 invoices          │
│ Started 14:02 by Grok        │
│                              │
│ 191 paid   6 held   3 refused│   counts, 700 weight, tabular
│ 200 checked in 41 s          │
│ Final on Monad in 1.1 s each │
│                              │
│ ■■■■■■■■■■■■■■■■■■■■         │   one tile per invoice, 20 per row
│ ■■■■■■■■■■■■■◩■■■■■■         │   ■ paid (Cleared, filled)
│ ■■■■■■■■■■■■■■■■■■■■         │   ◩ held (Held, notched corner)
│ ■■■■■■■◩■■■■■■■■■■■■         │   □ not checked yet (Guide outline)
│ …                            │   ▣ refused (Refused, crossed)
│                              │
│ Held, by reason              │
│ Address changed          2 › │
│ Duplicate invoice        3 › │   "Refuse all 3 duplicates"
│ Amount over the order    1 › │
└──────────────────────────────┘
```

- Tiles are information: one per invoice, in arrival order, tappable. On a laptop the grid widens and the held list sits beside it.
- Counts update live; no spinner. The summary sentence is the record ("200 checked in 41 s").
- Held payments are grouped by reason (D18). Duplicates can be refused together; changed addresses always open one by one.

### 3. Inbox

Things waiting for a person, newest first: proposed suppliers, proposed orders, held payments (grouped when they come from one run).

```
│ Proposed supplier                    │
│ Kalibre Studio, from their quote     │
│ Address listed on their website  ✓   │
│──────────────────────────────────────│
│ Held · Address changed               │
│ Kalibre Studio · 4,200.00 USDC       │
│──────────────────────────────────────│
```

Empty: "Nothing needs you. Matching invoices are paid without asking."

### 4. Payment record

One payment, as evidence. Rows, not cards:

- What was asked: supplier, invoice, amount.
- What was checked, each with a result: supplier on file, address on file, items match the order, amount within tolerance, not paid before, no hidden instructions found.
- Who decided: the checker, or a named person with their device ("Afshal, iPhone, Face ID").
- On Monad: the transaction, block and time to final, linked to MonadVision.
- "Download record" for the audit export (Slice 18).

### 5. Suppliers and orders

Each supplier: the address on file (Martian Mono), whether their website lists it, and their open orders with how much is left in each order's vault as a thin bar. Tapping an order shows its payments.

Empty: "No suppliers yet. Ask your agent to read a supplier's quote and propose one."

### Supplier portal (demo)

A plain supplier site (Kalibre Studio) that issues quotes and invoices, clean and doctored, and shows "Paid, final on Monad" arriving. It uses the supplier's own look, not Countersign's, so the demo clearly shows two separate parties.

## Words

- Plain, specific, active: "Approve with Face ID", then "Approved".
- Name things as a business would: supplier, order, invoice, payment, held, refused. Never "transaction intent", "mandate" or "nonce".
- **Never mention gas, MON or seed phrases.** Amounts are in USDC, shown as dollars with "USDC" after the number.
- Errors say what happened and what to do: "Your phone didn't confirm. Nothing was paid. Try again." Not "Something went wrong".
- A short explanation of stablecoins on first use: "Payments are in USDC, a digital dollar worth exactly one US dollar. They settle on Monad in about a second."

## Quality floor

- Phone first, from 360px wide; laptop from 1024px with the two-pane layout.
- Visible keyboard focus; screen-reader text for tiles ("Invoice 0142, held, address changed").
- Contrast AA at least for all text, checked for both modes.
- Works without the app installed; installable to the home screen.

## What I changed after checking this against the usual defaults

- **First draft used a near-black dark theme with one bright accent.** That is one of the most common generated looks. Changed to navy "ledger at night", with the same three state colours as light mode.
- **First draft put a monospace face on all small labels.** That is another common tell. Mono is now used only where comparing characters is the job: addresses, invoice numbers, hashes.
- **First draft had a big hero number with a gradient on the run board.** Replaced by the tile grid, which carries information (one tile per invoice), with plain counts beside it.
- **Considered a cream background with a serif.** Rejected; cheque security paper (cool, slightly green) is specific to this subject.
- **Red for held payments.** Changed: held means "look at this", not "error". Red is kept for refused.

## Open questions for Afshal

1. Is the "copies out of register" idea right as the one bold element?
2. The four tabs: Runs, Inbox, Payments, Suppliers. Anything missing for the demo?
3. Should the Slice 1 test page be restyled to this now, before the phone tests, or stay as a throwaway?

---

Map: CONTEXT-MAP
