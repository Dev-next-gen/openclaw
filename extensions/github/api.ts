// Public GitHub transport and preview data for core-owned project/session and
// compatibility integrations. Importing this barrel never activates the plugin.
export {
  CONTROL_UI_GITHUB_CREDENTIAL_UNAVAILABLE_MESSAGE,
  ControlUiGitHubError,
  discardResponse,
  fetchGitHubApi,
  fetchGitHubJson,
  formatControlUiGitHubPreviewError,
  GITHUB_API_ORIGIN,
  GITHUB_REQUEST_TIMEOUT_MS,
  GitHubGraphQLUnavailableError,
  githubApiCredentialCacheScope,
  githubApiToken,
  hasConfiguredGitHubApiCredential,
  isRecord,
  optionalNumber,
  readBoundedResponse,
  readGitHubGraphQLResponse,
  readGitHubJsonResponse,
  readOptionalGitHubString,
  requiredString,
  resolveGitHubApiCredentialScope,
  withOptionalGitHubAuth,
} from "./src/github-api.js";
export { loadControlUiGitHubPreview, parseControlUiGitHubPreviewTarget } from "./src/preview.js";
export type {
  ControlUiGitHubPreviewIdentity,
  ControlUiGitHubPreviewTarget,
} from "./src/preview.js";
export type { ControlUiGitHubPreview } from "./src/preview-contract.js";
