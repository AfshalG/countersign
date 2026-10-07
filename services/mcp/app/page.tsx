export default function Page() {
  return (
    <main>
      <h1>Countersign MCP server</h1>
      <p>
        Six tools that let an AI agent pay invoices from a Countersign account on Monad testnet:
        list_open_orders, check_invoice, pay_invoice, pay_invoices, payment_status and
        propose_order. The account pays only suppliers on file, at their addresses on file, within
        orders the owner approved; anything else is held for the owner.
      </p>
      <p>
        Connect from Claude Code:
        <br />
        <code>
          claude mcp add --transport http countersign https://&lt;this host&gt;/api/mcp --header
          &quot;Authorization: Bearer $TOKEN&quot;
        </code>
      </p>
      <p>
        Source and docs:{' '}
        <a href="https://github.com/AfshalG/countersign">github.com/AfshalG/countersign</a>
      </p>
    </main>
  );
}
