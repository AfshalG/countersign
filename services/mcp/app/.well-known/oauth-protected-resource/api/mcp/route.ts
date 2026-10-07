// RFC 9728 also places the document after the resource's path; some clients look here.
export { GET, OPTIONS } from '../../route';

// Next.js reads route settings from each file itself; a re-exported one is not recognised.
export const dynamic = 'force-dynamic';
