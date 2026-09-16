import fsSync from "node:fs";
import path from "node:path";
import type { AssistantMessage, UserMessage } from "openclaw/plugin-sdk/llm";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { createZeroUsageFixture } from "../../agents/test-helpers/usage-fixtures.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";

export const getSessionManagerModule = createLazyRuntimeModule(
  () => import("../../agents/sessions/index.js"),
);

function writeSessionFixture(
  sessionFile: string,
  session: { getPersistedEntries(): unknown[] },
): void {
  const contents = session
    .getPersistedEntries()
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  fsSync.writeFileSync(sessionFile, `${contents}\n`, "utf8");
}

export async function createCheckpointFixture(
  dir: string,
  options: { legacyPreCompactionSnapshot?: boolean } = { legacyPreCompactionSnapshot: true },
) {
  const { SessionManager } = await getSessionManagerModule();
  const session = SessionManager.inMemory(dir);
  const userMessage: UserMessage = {
    role: "user",
    content: "before compaction",
    timestamp: Date.now(),
  };
  const assistantMessage: AssistantMessage = makeAgentAssistantMessage({
    content: [{ type: "text", text: "working on it" }],
    api: "responses",
    model: "gpt-test",
    usage: {
      ...createZeroUsageFixture(),
      input: 1,
      output: 1,
      totalTokens: 2,
    },
    timestamp: Date.now(),
  });
  session.appendMessage(userMessage);
  session.appendMessage(assistantMessage);
  const preCompactionLeafId = session.getLeafId();
  if (!preCompactionLeafId) {
    throw new Error("expected persisted session leaf before compaction");
  }
  const sessionFile = path.join(dir, `${session.getSessionId()}.jsonl`);
  writeSessionFixture(sessionFile, session);
  const legacyPreCompactionSnapshot = options.legacyPreCompactionSnapshot ?? true;
  const preCompactionSessionFile = legacyPreCompactionSnapshot
    ? path.join(dir, `${path.parse(sessionFile).name}.checkpoint-test.jsonl`)
    : undefined;
  if (preCompactionSessionFile) {
    fsSync.copyFileSync(sessionFile, preCompactionSessionFile);
  }
  const preCompactionSession = preCompactionSessionFile
    ? SessionManager.fromEntries(session.getPersistedEntries(), dir)
    : undefined;
  session.appendCompaction("checkpoint summary", preCompactionLeafId, 123, { ok: true });
  const postCompactionLeafId = session.getLeafId();
  if (!postCompactionLeafId) {
    throw new Error("expected post-compaction leaf");
  }
  writeSessionFixture(sessionFile, session);
  return {
    session,
    sessionId: session.getSessionId(),
    sessionFile,
    preCompactionSession,
    preCompactionSessionFile,
    preCompactionLeafId,
    postCompactionLeafId,
  };
}
