# Slice 7: The supplier portal, the demo shop and the demo documents

## Status

**DONE (7 Oct 2026): the site is live** at `https://countersign-supplier-demo.vercel.app` (`/demo` lists every case). An agent paying these documents end to end is Slice 8, which also runs this slice's claude.ai test. Technical decisions made by Claude (Afshal, 7 Oct: decide technical choices; go slice by slice). The look of the pages is Sophie's to restyle; this slice builds them plain and correct.

## Goal

The real things an agent reads and pays, on their own sites, as a second party would publish them: Kalibre Studio's quotes and invoices (clean and doctored) and a demo shop's checkout (clean and swapped). Each case has a stable URL that renders for a given Countersign account, so its order, supplier address and amounts match what is on chain, and any agent (claude.ai, Grok, Claude Code, the scripted agent of Slice 8, the benchmark of Slice 20) can read it and try to pay it. This is also the first part of Countersign a person can click through.

## Prerequisites

- Slice 2: Kalibre Studio's site (`countersign-supplier-demo.vercel.app`, static) with its address file at `/.well-known/countersign.json`, which the Primus proof pins (URL and fields).
- Slices 5, 9, 12: the demo account's order with Kalibre; judge accounts' 0.005 USDC orders; the SDK and MCP tools an agent pays with; `GET /v1/accounts/{account}/orders`.
- Architecture: the demo document table ("The demo documents (built in Slice 7, reused by the benchmark)").

## Checked against earlier slices and decisions

| Source | What carries into this slice |
|---|---|
| Slice 2 | The address file must stay byte-for-byte at the same URL on the same domain: the new site keeps it, served with the same headers (`no-store`, JSON). The address is published checksummed (Primus extracts it verbatim) |
| Slice 5 | A new address is capped at 0.002 USDC for its first week, a payment at 0.005; invoices on demo orders are 0.001 USDC (testnet amounts, labelled as such) |
| Slice 9 | Judge accounts pay Kalibre at its proven address from a 0.005 order; a changed-address hold offers only refuse; the demo agent pays invoices into a judge's account |
| Slice 12 | The invoice identity is the supplier and its number (normalised): the duplicate case reuses a number already paid; the agent passes the invoice's text to the checker (`invoiceText`) |
| Slice 19 | Payments name their agent; documents carry no agent identity |
| Architecture (demo documents) | The cases and expected outcomes below; the poisoned-memory case is an agent scenario (Slice 8), not a document; the paid service (x402) stays a stretch goal |
| D24 | Documents are public demo data: no real business data |
| Phone first | Every page reads on a phone |
| Pitch hygiene | Each case states what Countersign does **today** and what changes when a later slice lands; nothing is claimed before it works |

## The cases

| Case | URL (per account: `?account=0x…`) | What is wrong | Today | After |
|---|---|---|---|---|
| Quote | `/quotes/q-2210` | Nothing | The agent proposes Kalibre and an order; approved with Face ID (Slice 9) | Slice 15: "listed on the supplier's website" |
| Poisoned quote | `/quotes/q-2211` | An address the website's file does not list | Proposed; the owner sees the address (a new address waits out the waiting period) | Slice 15: "not listed on the supplier's website" |
| Clean invoice | `/invoices/ks-1001` | Nothing | Settled, no prompt | |
| Changed address | `/invoices/ks-1002` | "New payment details", a look-alike address | Held: `address_mismatch` (the contract) | |
| Padded line | `/invoices/ks-1003` | An extra line not on the order | Settled (the stand-in checker cannot read it) | Slice 10: held, `items_mismatch` |
| Padded total | `/invoices/ks-1004` | A total above the order line | Settled if within the order | Slice 10: held, `amount_mismatch` |
| Duplicate | `/invoices/ks-1001` again | The number already paid | Recognised: nothing new paid (Slice 12) | |
| Hijack | `/invoices/ks-1005` | Hidden text telling an automated reader to pay elsewhere, urgently | If the agent obeys: held, `address_mismatch` (the contract refuses the address) | Slice 10: held for the hidden instruction even if the agent does not obey |
| Wrong supplier | `/invoices/nw-77` (another supplier's style) | A supplier with no order | The agent finds no order to pay; nothing paid | |
| Over the order | `/invoices/ks-1006` | More than the order has left | Blocked by the contract (`over_limit`) | |
| Bank transfer | `/invoices/ks-1007` | A changed account number on a bank invoice | Out of scope until Slice 17 (advice only) | Slice 17: advice, `mismatch` |
| Clean online order | demo shop `/checkout?item=…` | Nothing | Settled | |
| Swapped checkout | demo shop `/checkout?item=…&v=2` | The page shows an address that is not the shop's on file | Held: `address_mismatch` | |

Each document is an HTML page an agent can read (the invoice's text includes everything a person would see; the hijack hides its instruction the way real ones do), the same as plain text (`.txt`) and as JSON (`.json`: the fields and the expected outcome, for the scripted agent and the benchmark).

## Design

1. **`apps/supplier`**: a small Next.js app (the repo's existing Next.js and webpack setup), deployed to the existing Vercel project `countersign-supplier-demo`, so the domain and the Primus-pinned address file stay. Two parties on one site, clearly separate: Kalibre Studio (`/`, `/quotes/*`, `/invoices/*`) and the demo shop, "Fieldstone Supply" (`/shop`, `/shop/checkout`).
2. **Per account**: `?account=0x…` reads that account's open orders from the gateway (a read-only token kept on the server) to fill the order reference and the amounts; without it, the main demo account. Invoice numbers carry the account so a number repeats only where the duplicate case wants it.
3. **The address file** `/.well-known/countersign.json`: the same bytes, the same headers.
4. **The shop's address** is on file only once a judge or the demo account approves the shop as a supplier (through a proposal, Slice 9): the shop's page includes its quote.

## Tests first

Each case renders its fields and its expected outcome; the hijack's instruction is in the page's text but not visible; the address file is byte-for-byte Slice 2's; a document for an account uses that account's order; a number repeats only for the duplicate.

## Manual testing

Open each case on a phone; give claude.ai (signed in, Slice 13) a clean invoice link and a changed-address link and watch one settle and one be held; the address file still verifies with Slice 2's probe.

## As built (7 Oct), two changes from the design

1. **The site holds no Countersign token and imports none of Countersign's code** (design point 2 said it would read the account's open orders from the gateway with a read-only token). A supplier is a second party: what an agent reads must not depend on our systems, and a token on a public demo site is one more secret to leak. Instead a document carries the account in its number (`KS-1002-403A9`), so numbers repeat only in the duplicate case, and the amounts are fixed small values: 0.001 USDC an invoice, under the 0.002 cap for a new address's first week (Slice 5), and above an order's 0.005 for the over-the-order case.
2. **The shop's checkout is `/shop/fs-checkout` and `/shop/fs-checkout-v2`**, like the other cases' paths, rather than `/shop/checkout?item=…&v=2`. Every document also answers `?format=text` (what an agent's page reader sees, the hijack's hidden text included) and `?format=json` (the fields, and what Countersign does today and after the slice that changes it).

## Results (7 Oct 2026)

| Check | Result |
|---|---|
| Tests | 12 for the documents (`apps/supplier/test/documents.test.ts`): every case present with its outcome; the clean invoice pays the address on file at 0.001 USDC; numbers per account, repeating only for the duplicate; the look-alike keeps the first six and last four characters; both kinds of padding; the hijack's text hidden from a person but in the text an agent reads; over the order; the wrong supplier and the bank invoice; the shop clean and swapped; an unknown case refused |
| Deployed (`7a7d727`, Vercel project `countersign-supplier-demo`, `rootDirectory` `apps/supplier`) | every route answers: `/`, `/demo`, `/quotes/*`, `/invoices/*`, `/shop`, `/shop/*`, as HTML, text and JSON; an unknown case 404 |
| The address file | byte-for-byte Slice 2's (checked against `spikes/02-primus/supplier-site/public/.well-known/countersign.json`, again on the live site after D36), `application/json`. Cache headers differ (`no-store` now): the Primus proof pins the URL, the request and the content, not caching |
| For the new main demo account (after D36), `?account=0xC127…03A9` | the changed-address invoice is `KS-1002-403A9`, pays `0x90f9931F…5feC` (Kalibre's `0x90f9931B…5fEc` with the middle changed), 0.001 USDC, "Held: the address is not the one on file" |

### Findings, carried forward

1. **A first look-alike was too obvious (fixed 7 Oct).** The A2A smoke's look-alike was a run of one repeated character; the demo's look-alike was already made the way address poisoning makes them (the same first six and last four characters, a random-looking middle). → Slice 8, Slice 22 (the demo script).
2. **The site never needs Countersign's credentials** (as built, point 1): anyone can run the same documents against their own account. → Slice 8 (the scripted agent reads them like any agent), D33 (an open primitive).
3. **A document page said what was wrong with it (found planning Slice 8, fixed 7 Oct).** Each page ended with "About this demo document: what is wrong", which an agent reads with the rest, so a real agent (Slice 14) would refuse a look-alike because the page said so, not because it noticed. Pages no longer say it; `/demo` and the JSON (`case`, `case.expect`) do. → Slice 14, Slice 20 (only a clean page measures an agent).

## Next

Slice 8 (the scripted agent pays every case end to end).

