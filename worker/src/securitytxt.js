// RFC 9116 security contact. Contact = the address already published in the site's privacy notice.
// Expires is generated per request, always one year ahead, so the file never goes stale.
export const CONTACT = 'mailto:malcolm@aichef.food';
export function securityTxt(now = new Date()) {
  return [`Contact: ${CONTACT}`, `Expires: ${new Date(now.getTime() + 365 * 864e5).toISOString()}`, 'Preferred-Languages: en',
    'Canonical: https://aichef.food/.well-known/security.txt', 'Policy: https://aichef.food/privacy.html', ''].join('\n');
}
