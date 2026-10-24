// `yokoten doctor`: a guide along the road (record 0004), and a check that this machine
// still runs the practices.
//
// Copying a setup once is not enough; it drifts. So doctor runs at the start of every
// session (`--session`, via the hook install adds). A beginner can't take in a list of
// everything missing, so a session hears three lines: the stage, the one next step, and
// why, and once a line about a new kit lesson that finds something here. Full `doctor`
// shows the whole map. A project that decided against a step says so
// in yokoten.json "notNow", and doctor stops asking.
//
// Doctor first checks itself: it feeds each check a known-bad input and expects a catch.

// The parts keep the public names here, so callers change only their import path.
// checks: the practice checks outside the road; self-test: their known-bad inputs;
// machine: disk, temp folders and Node; lessons: the kit lessons and their state;
// report: the road report, the session lines, and the server notes.

export {
  agentHooks,
  allowedMarkCount,
  commandWording,
  coreRulesCheck,
  doubleInstallCheck,
  editedKitCheck,
  launcherCheck,
  machineChecks,
  OUTPUT_STOP,
  PLUGIN_UPDATE,
  pluginAgeCheck,
  privacyNotes,
  releaseChannel,
  UNFILTERED,
  userAgentHooks,
} from './checks.ts';
export {
  coreRulesControl,
  type DoctorState,
  findStateFile,
  formatLessonChecks,
  kitLessons,
  type LessonCheck,
  lessonChecks,
  readState,
  saveState,
  seenAfter,
  sessionLessonNote,
  STATE_FILE,
} from './lessons.ts';
export {
  agentTempDirCheck,
  diskSpaceChecks,
  diskSpaceNote,
  type DiskSpace,
  findDriveMount,
  HOST_DISK_FIX,
  type HostDiskCache,
  type HostDiskRead,
  isLowOnSpace,
  isWsl,
  leftoverControl,
  leftoverTempCheck,
  machineControl,
  type MachineProbe,
  NODE_ADVISORY,
  NODE_FIXED,
  nodeSecurityCheck,
  parseLxss,
  quoteForShell,
  readFreshHostCache,
  readHostCache,
  readHostDisk,
  readYokotenFolders,
  REAL_MACHINE,
  saveHostCache,
  type TempFolderEntry,
  WSL_DISK_GUIDE,
  type WslDistro,
} from './machine.ts';
export {
  blocksToSay,
  doctor,
  type DoctorReport,
  guardCostCheck,
  listBoardSteps,
  NO_CI_GAPS,
  NO_HOME_NOTE,
  noCiNote,
  OFFER,
  PLUGIN_COMMANDS,
  ROAD_DONE,
  SERVER_TIMEOUT_MS,
  SESSION_UNSAVED_BUDGET,
  sessionUnsaved,
  type SessionStart,
  sessionsDir,
  type StepState,
  STOPPED_EARLY,
  UNSAVED_OFFER,
  upstreamNote,
} from './report.ts';
export { isShellControlCaught, isUnsavedControlCaught, sandboxControl, selfTest } from './self-test.ts';
