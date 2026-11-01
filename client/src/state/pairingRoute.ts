import { router } from 'expo-router';

/**
 * Opens the pairing screen as a modal over the tabs, to add a computer or,
 * with `computerId` (the `computer` search param), to re-pair one whose
 * pairing stopped working. Pairing there switches to that computer and closes
 * the modal.
 */
export function openPairing(computerId?: string): void {
  router.push(computerId ? { pathname: '/pair', params: { computer: computerId } } : '/pair');
}
