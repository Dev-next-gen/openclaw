/**
 * Runtime SDK subpath for secret input normalization and configured secret resolution.
 */
import { assertSecretOwnerAvailable } from "../secrets/runtime-degraded-state.js";

export {
  coerceSecretRef,
  hasConfiguredSecretInput,
  isSecretRef,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
  resolveSecretInputString,
  type SecretInput,
  type SecretInputStringResolution,
  type SecretInputStringResolutionMode,
} from "../config/types.secrets.js";
export {
  resolveConfiguredSecretInputString,
  resolveConfiguredSecretInputWithFallback,
  resolveRequiredConfiguredSecretRefInputString,
} from "../gateway/resolve-configured-secret-input-string.js";

/** Reject use of a manifest-owned plugin capability whose startup secret is unavailable. */
export function assertPluginCapabilitySecretAvailable(ownerId: string): void {
  assertSecretOwnerAvailable("capability", ownerId);
}

// Preserve typed fail-closed errors when a plugin owns the transport.
export {
  SecretSurfaceUnavailableError,
  isTrustedSecretSurfaceUnavailableError,
} from "../secrets/runtime-degraded-state.js";
