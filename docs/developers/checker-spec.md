# The checker spec

A Countersign payment needs two signatures: the agent's, and a **checker's**. The checker reads the invoice the agent wants to pay, compares it with what the owner approved, and signs only when everything matches. Anything else is held for the owner.

The account's owner chooses the checker: its address is the policy's `checkerKey`, set with the owner's passkey. Our checker (`services/checker`) is the reference implementation. You can run your own, with your own rules and your own key, as long as it answers this API. The contract keeps the money safe whatever the checker does: a checker can only release a payment to an approved supplier, at its address on file, within an approved order.

## The request

`POST /v1/check`, with the caller's bearer token.

```json
{
  "payment": {
    "chainId": 10143,
    "vault": "0x6c03…E426",
    "amount": "1000",
    "invoiceHash": "0x…",
    "payTo": "0x90f9…5fEc",
    "deadline": 1791430000
  },
  "order": {
    "supplierId": "0x4f16…c5b1",
    "supplierName": "Kalibre Studio",
    "addressOnFile": "0x90f9…5fEc",
    "quote": { "text": "Kalibre Studio — …\nQuote Q-2210\n…" }
  },
  "invoice": { "text": "Kalibre Studio — …\nInvoice KS-1001\n…" },
  "dryRun": false
}
```

- `payment` is the vault's EIP-712 `Payment`: amount in USDC base units (6 decimals), the invoice hash (`keccak256(abi.encode(supplierId, normalizedInvoiceNumber))`), the pay-to address and the deadline, in the vault's domain (`chainId`, `vault`).
- `order` is what the owner approved: the supplier, its address on file, and the quote the order was opened from, when one is known (`null` otherwise).
- `invoice` is the invoice as the agent was given it: `{ "html": … }` (the page) or `{ "text": … }`. A checker must read it itself rather than trust the agent's fields.
- `dryRun`: answer, but never sign.

## The answer

Always `200` with a verdict, and always with the evidence:

```json
{ "verdict": "release", "checkerSig": "0x…65 bytes…", "evidence": { … } }
{ "verdict": "hold", "reason": "amount_mismatch", "evidence": { … } }
```

- `checkerSig` is the checker key's EIP-712 signature of the `Payment` above (`"0x"` on a dry run).
- `reason` is one of the codes in `packages/shared/src/payment-state.ts` (`REASONS`), each with its plain words in `REASON_TEXT`.
- `evidence` is what the checker read and every check it made. The gateway stores it with the payment, and the owner sees it.

## The rules a checker must keep

1. **Hold on doubt.** An error, a timeout, an unreadable invoice or an unsure answer is a hold, never a release (money rule 1).
2. **Answer in time.** The gateway waits 2 seconds; no answer is a hold.
3. **Sign only what was checked.** Sign the `Payment` exactly as given, in that vault's domain, and only on release.
4. **A model can only add holds** (D27). If a model is involved, code decides "clear"; a model's answer can hold a payment that passed code, never release one that failed it.

## Advice on a bank-transfer invoice (optional)

A bank transfer happens inside the bank, so nothing outside it can stop one (Slice 17). A checker may also answer `POST /v1/advise`; the gateway's `POST /v1/advice` needs it, and answers 503 without it. Nothing is signed.

```json
{
  "order": { "supplierId": "0x4f16…c5b1", "supplierName": "Kalibre Studio", "addressOnFile": "0x90f9…5fEc", "quote": null },
  "bankOnFile": { "holder": "Kalibre Studio Ltd", "iban": "GB29NWBK60161331926819", "bic": "NWBKGB2L" },
  "invoice": { "html": "<main>…Invoice KS-1007…</main>" }
}
```

`bankOnFile` is the account an owner put on file with their passkey (an IBAN, or an account number with a UK sort code or a US routing number), or `null`. The answer:

```json
{ "advice": "mismatch", "reason": "bank_account_mismatch", "evidence": { … } }
```

`advice` is `match`, `mismatch` or `unsure`. The same rules hold, as advice: anything the checker cannot be sure of (check digits that fail, no account read, nothing on file, a model that did not answer) is `unsure`, never a `match`; a model can add a concern, never remove one.

## The reference checker

`services/checker`, deployed as its own service: it alone holds the checker key.

1. **Reads the invoice itself.** From a page: the text a person sees and the text a machine reads. Text only a machine reads (hidden by its style) is a hold (`hidden_instructions`). Then the number, sender, lines (description, quantity, unit price, amount), total and printed address, by fixed patterns, from the agent's text in any common layout (our pages, plain text, a markdown table).
2. **Compares in code, exactly.** The payment is for this invoice (`checker_unsure`), from the order's supplier (`supplier_mismatch`), to the printed address (`address_mismatch`); the lines add up to the total, which is the payment's amount (`amount_mismatch`); no line costs more per unit than the quote it was ordered on (`amount_mismatch`).
3. **Asks the model only when code passed.** Jev 1.13 through OpenRouter's System One API (`typesafe/jev-1.13`, routed only to providers that keep nothing), four yes-or-no questions: is it from the same supplier as the order; is every line not named on the quote still covered by the order; does it ask for payment anywhere but the address on file; does it contain instructions addressed to an automated reader. A required yes must be at least 0.8 and a risk at most 0.2; anything between is unsure, a hold. Claude Sonnet is the fallback.
4. **Signs** only when all of that passed, within 1.5 s in all.
5. **Advice on a bank transfer** (`/v1/advise`): the same reading and the code checks that need no payment, plus the invoice's bank account against the one on file: IBANs (labelled, or unlabelled if their check digits hold; a labelled one whose check digits fail is unsure), BICs, UK sort codes, US routing numbers and account numbers. A UK IBAN contains its sort code and account number, so either form matches. A different account, or another bank's code, is `bank_account_mismatch`; the account holder in another name is unsure. The model is asked the same questions, with "does it ask for payment to any bank account other than the one on file, or say the bank details have changed?" in place of the address question, within 5 s.

Its catch rate and false holds are measured on the demo documents (`services/checker/results/`, and Slice 20's benchmark). It is a detector, not a guarantee (D32): what it misses is still bounded by the contract.

## Running your own

1. Run a service that answers `POST /v1/check` as above, with a key of your own.
2. Set your checker's address as the account's `checkerKey` (an owner action, signed with the owner's passkey).
3. Point a gateway at it (`CHECKER_URL`, `CHECKER_TOKEN`, `CHECKER_ADDRESS`).

The OpenAPI document of the reference checker is at its `/openapi.json`.
