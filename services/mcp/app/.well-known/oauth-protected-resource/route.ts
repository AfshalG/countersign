import { corsPreflight, protectedResource } from '../../../lib/discovery';
import { hosted } from '../../../lib/hosted';

// Read at request time: the settings are runtime secrets, never baked in at build.
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return protectedResource(hosted().authkit);
}
export { corsPreflight as OPTIONS };
