import { authorizationServer, corsPreflight } from '../../../lib/discovery';
import { hosted } from '../../../lib/hosted';

export const dynamic = 'force-dynamic';

export function GET(): Promise<Response> {
  return authorizationServer(hosted().authkit?.issuer);
}
export { corsPreflight as OPTIONS };
