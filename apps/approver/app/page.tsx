// The approver app (Sophie). This is the empty shell: it builds and imports our packages.
// Screens to build: passkey sign-in, /approve/[id] (summary, address diff, pay once / refuse),
// approving a proposed supplier and order, judge mode. See README.md.
import { formatUsdc } from '@countersign/shared';

export default function Page() {
  return (
    <main>
      <h1>Countersign</h1>
      <p>
        Approver app shell. Example amount from the shared package: {formatUsdc(12_500_000n)} USDC.
      </p>
    </main>
  );
}
