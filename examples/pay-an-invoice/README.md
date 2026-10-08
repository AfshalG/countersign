# Pay an invoice with the SDK

```bash
npm install
npm run account   # once: a testnet account for a new agent key, written to .env (about ten seconds)
npm start
```

`npm run account` makes your own test account: an owner key (standing in for a passkey on a phone), an agent key, the account with 0.01 test USDC, the demo supplier Kalibre Studio and a 0.005 USDC order, and a token that reaches only this account. Nothing is sent to us but the public halves.

`npm start` reads Kalibre Studio's clean invoice from the supplier's own page, pays it through your account and waits until it is settled at Monad's Finalized stage. Change `ks-1001` to `ks-1002` (a look-alike address) and it is held instead, with the reason and a link: the account pays only the address on file. Decide a hold with the owner key:

```js
import { decide } from '@countersign/sdk/test-account';
await decide({ id: result.id, action: 'refuse', ownerKey: process.env.COUNTERSIGN_OWNER_KEY });
```
