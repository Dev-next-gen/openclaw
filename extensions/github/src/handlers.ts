import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import { loadGitHubDetail } from "./detail.js";
import { ControlUiGitHubError, formatControlUiGitHubPreviewError } from "./github-api.js";
import { isControlUiGitHubPreview } from "./preview-contract.js";
import { parseGitHubLinkParams } from "./targets.js";
import { githubPreviewView } from "./view-model.js";

type ReaderMethod = "github.preview" | "github.detail";

async function handleGitHubRequest(
  method: ReaderMethod,
  { params, respond }: GatewayRequestHandlerOptions,
) {
  const parsed = parseGitHubLinkParams(params);
  if (!parsed || (method === "github.preview" && parsed.target.kind === "commit")) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "invalid " + method + " params"),
    );
    return;
  }
  try {
    if (method === "github.preview" && parsed.target.kind !== "commit") {
      // The entitled dispatcher retains this request's exact client. The host
      // adapter alone selects/revalidates managed identities and caller lifetime.
      const result = await dispatchGatewayMethod("controlUi.githubPreview", {
        ...parsed.target,
        ...(parsed.agentId ? { agentId: parsed.agentId } : {}),
        ...(parsed.refresh ? { refresh: true } : {}),
      });
      if (!result.ok) {
        respond(false, result.payload, result.error, result.meta);
        return;
      }
      if (!isControlUiGitHubPreview(result.payload)) {
        throw new ControlUiGitHubError(502, "GitHub preview returned an invalid response");
      }
      respond(true, githubPreviewView(result.payload), undefined, result.meta);
    } else {
      // Documents never use ambient or selected credentials, including refreshes.
      const document = await loadGitHubDetail(parsed.target, undefined, parsed.refresh);
      respond(true, { ...document, filesExpanded: parsed.filesExpanded }, undefined);
    }
  } catch (error) {
    const { message, ...details } = formatControlUiGitHubPreviewError(error);
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message, details));
  }
}

export const githubHandlers = {
  "github.preview": (options: GatewayRequestHandlerOptions) =>
    handleGitHubRequest("github.preview", options),
  "github.detail": (options: GatewayRequestHandlerOptions) =>
    handleGitHubRequest("github.detail", options),
};
