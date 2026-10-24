// How the board groups a role (#693). script.ts lists these functions, and page.ts puts
// their source into the page, so each one uses only its arguments.

/**
 * The group a role goes in, by the work its name contains. Case does not matter.
 * `develop` is checked before `pm`, so "development" stays with the engineers.
 * An unknown role is a helper. The main checkout's lead is drawn apart from these groups.
 */
export function roleGroup(role: string): string {
  const name = role.toLowerCase();
  if (name.includes('review')) return 'group.reviewer';
  if (/verif|check|test/.test(name)) return 'group.verifier';
  if (/work|engineer|senior|develop|coder/.test(name)) return 'group.engineer';
  if (name.includes('lead') || name.includes('manager') || name.includes('pm')) return 'group.manager';
  return 'group.helper';
}

/** The main checkout's lead: it works in that checkout, and its role says lead. */
export function isCheckoutLead(agent: { isMain: boolean; role: string }): boolean {
  return agent.isMain && agent.role.toLowerCase().includes('lead');
}
