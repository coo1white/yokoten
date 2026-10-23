// A test's child loads this instead of home.ts. home.ts would point HOME at a new empty
// folder and hide the sandbox home. This only turns off the password-database marks read,
// so a child never opens the real private-marks file (#356, #739).

import { useRealHome } from '../../src/rules/privacy.ts';

useRealHome(() => '');
