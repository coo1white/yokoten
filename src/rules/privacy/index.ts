// The privacy rule: nothing in the repo points at the person behind it, or opens their
// accounts. Three kinds of check:
//
// - Patterns anyone can see: email addresses and IPv4 addresses. A few are always fine
//   (GitHub's noreply addresses, the documentation ranges, localhost).
// - Marks only the owner knows: their name, their city, their domain, a server's name.
//   These live in a file OUTSIDE the repo (~/.config/yokoten/private-marks, one per line),
//   because a list of what must not be published cannot itself be published. CI does not
//   have the file, so CI checks the patterns only; the commit check on the owner's machine
//   checks both.
// - Secrets: tokens and private keys, in secrets.ts. Their hits pass through scanText too,
//   so every caller (the commit, CI, the history) catches them.

export {
  homeIn,
  homeOf,
  loadMarks,
  marksFile,
  marksFiles,
  NO_HOME,
  ownMarks,
  realHomeRead,
  systemHome,
  useRealHome,
  withHome,
  writtenMarksOnly,
} from './home.ts';
export {
  ALLOW_FILE_SHAPE,
  ALLOW_FILE_UNREADABLE,
  type AllowEntry,
  isLink,
  machineAllowFile,
  type MachineAllowed,
  machineAllowed,
  matchingEntries,
  NO_ORIGIN,
  normalizeRemote,
  readMachineAllow,
  type RepoKey,
  repoKey,
  repoMarkKinds,
  sameNameMarks,
  skipsOwnName,
} from './allow.ts';
export {
  autoLogins,
  describeMark,
  EMAIL_FIX,
  type FoldedLine,
  type FoldedText,
  foldLine,
  foldMark,
  foldText,
  FOUND_HEADER,
  foundHeader,
  hasMark,
  isDomainShaped,
  isEmailShaped,
  isPersonalEmail,
  loadMarkKinds,
  type Mark,
  markLines,
  markPattern,
  mapMarkKinds,
  OWN_HEADER,
  PUBLIC_FORGES,
} from './marks.ts';
export {
  addedIgnores,
  type Hidden,
  hideHome,
  IGNORE_FILE,
  loadIgnores,
  makeRedactor,
  notUtc,
  PLACEHOLDERS,
  POSITIVE_CONTROL,
  privateRemoteHosts,
  scanText,
  TIME_ZONE_FIX,
} from './scan.ts';
export {
  type GhCommand,
  ghIndex,
  heredocBodies,
  type HostApi,
  type HostApiCall,
  hostApiClusterFinding,
  hostApiValues,
  optionValue,
  readHostApi,
  useHostApi,
} from './post/post.ts';
export {
  checkPost,
  type CommandFiles,
  isBotProgram,
  lonePost,
  namesTarget,
  PIPE_READERS,
  type Risk,
  withoutReadPipe,
} from './post/check-post.ts';
