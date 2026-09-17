export const managedWindowsJobEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "managed-windows-job-launcher",
  sourceExtension: ".mts",
  distWorkerPath: "tooling/managed-windows-job-launcher.js",
} as const;
