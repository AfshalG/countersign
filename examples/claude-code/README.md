# Countersign in Claude Code

```bash
claude mcp add --transport http countersign https://countersign-mcp.vercel.app/api/mcp \
  --header "Authorization: Bearer $COUNTERSIGN_MCP_TOKEN"
```

Then, for example: "List my open Countersign orders, then pay invoice INV-0042 for 0.001 USDC to the supplier on the first order." Try a different payment address to see a hold.
