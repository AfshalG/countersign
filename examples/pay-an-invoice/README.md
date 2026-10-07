# Pay an invoice with the SDK

```bash
npm install
COUNTERSIGN_TOKEN=… COUNTERSIGN_ACCOUNT=0x… AGENT_PRIVATE_KEY=0x… npm start
```

Lists your account's open orders and pays one 0.001 USDC invoice to the order's supplier, waiting until it is settled at Monad's Finalized stage. Change `payTo` to any other address and it is held instead, with the reason and a link: the account pays only the address on file.
