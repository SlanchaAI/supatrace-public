// One place to ask whether the page may leave the open workspace right now. app.js gives mountWorkspaces a guard
// that is false while an export, a redaction preview, a billing action or a key revocation is running, because a
// reload or a switch would cut that operation off. mountWorkspaces registers it here, so every panel that reloads
// or navigates (the selectors, the Projects card) asks the same question. Until a guard is registered nothing is
// running that could be interrupted, and the answer is yes.
let guard = null;
export function setSwitchGuard(check) { if (typeof check !== 'function') throw new Error('invalid_switch_guard'); guard = check; }
export const switchGuardInstalled = () => guard !== null;
export const switchAllowed = () => guard === null || guard() === true;
export const SWITCH_BLOCKED = 'Finish or cancel the current operation before switching workspace or environment.';
