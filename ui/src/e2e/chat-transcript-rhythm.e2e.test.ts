import { expect, it } from "vitest";
import {
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { requireRecord, requireString, waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI transcript rhythm",
  startServerBeforeBrowser: true,
});
const preview =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAAB4CAIAAAAMrLyJAAABeklEQVR4nO3TQQ0AIBDAsLOLH9SgDg98yJImFbDPZu0DRM33AuCZgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhF1yvSRAUBuKQAAAAAElFTkSuQmCC";
const presenceUsers = [
  { id: "riley", name: "Riley", self: true, identity: { type: "profile", id: "riley" } },
  { id: "colin", name: "Colin", self: false, identity: { type: "profile", id: "colin" } },
] satisfies ControlUiMockGatewayScenario["presenceUsers"];

function historyFixture() {
  type Message = {
    role: string;
    content: Record<string, unknown>[];
    timestamp: number;
    runId?: string;
    __openclaw: Record<string, unknown>;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
  };
  const messages: Message[] = [];
  const user = (
    text: string,
    index = 0,
    content: Record<string, unknown>[] = [{ type: "text", text }],
  ) => {
    const sender = presenceUsers[index]!;
    messages.push({
      role: "user",
      content,
      timestamp: 1789552800000 + messages.length * 1000,
      __openclaw: { senderId: sender.id, senderIdentity: sender.identity, senderName: sender.name },
    });
  };
  const assistant = (text: string, runId = "first-run") => {
    messages.push({
      role: "assistant",
      content: [{ type: "text", text }],
      runId,
      timestamp: 1789552800000 + messages.length * 1000,
      __openclaw: {},
    });
  };
  const tool = (name: string, index: number, isError = false, runId = "first-run") => {
    const id = `call-${index}`,
      timestamp = 1789552800000 + messages.length * 1000;
    messages.push(
      {
        role: "assistant",
        content: [{ type: "toolCall", id, name, arguments: { path: `notes-${index}.txt` } }],
        runId,
        timestamp,
        __openclaw: {},
      },
      {
        role: "toolResult",
        toolCallId: id,
        toolName: name,
        content: [
          {
            type: "text",
            text: isError ? "Synthetic failure: file unavailable." : "Synthetic check complete.",
          },
        ],
        isError,
        runId,
        timestamp: timestamp + 100,
        __openclaw: {},
      },
    );
  };
  user("Please check these changes and summarize the results.");
  tool("read", 1);
  tool("exec", 11);
  assistant("The first file is ready.");
  tool("exec", 2, true);
  tool("read", 12);
  assistant("One check failed. I will inspect the remaining notes.");
  tool("read", 3);
  tool("exec", 13);
  assistant("The remaining notes are consistent.\n\nThe next step is a final review.");
  user("", 0, [
    {
      type: "attachment",
      attachment: {
        kind: "document",
        label: "review-notes.txt",
        mimeType: "text/plain",
        url: "https://example.com/review-notes.txt",
        sizeBytes: 1024,
      },
    },
    { type: "text", text: "Please include this preview and the attached notes." },
  ]);
  messages.at(-1)!["__openclaw"].media = [
    {
      url: preview,
      contentType: "image/png",
      fileName: "layout-preview.png",
      width: 320,
      height: 120,
    },
  ];
  user("I checked the preview. The file is ready.", 1);
  user("Thank you. Please finish the review.");
  tool("read", 4, false, "final-run");
  tool("exec", 5, false, "final-run");
  assistant("Final review is ready.", "final-run");
  messages.forEach((message, index) => {
    Object.assign(message["__openclaw"], {
      id: `rhythm-${index}`,
      seq: index + 1,
      runId:
        message.runId ??
        (index === 0
          ? "first-run"
          : message.content[0]?.text === "Thank you. Please finish the review."
            ? "final-run"
            : `user-run-${index}`),
    });
  });
  return messages;
}

suite.define(() => {
  it.each(
    [1440, 390].flatMap((width) =>
      (["light", "dark"] as const).map((colorScheme) => ({ width, colorScheme })),
    ),
  )(
    "preserves known image geometry and surrounding rhythm at $width px in $colorScheme",
    async ({ width, colorScheme }) => {
      await suite.withPage(
        {
          viewport: { width, height: 900 },
          colorScheme,
          hasTouch: width === 390,
          reducedMotion: "reduce",
        },
        async ({ page }) => {
          await page.clock.setFixedTime(new Date("2026-09-16T10:00:00Z"));
          const gateway = await installMockGateway(page, {
            historyMessages: historyFixture(),
            presenceUsers,
          });
          await page.goto(`${suite.server.baseUrl}chat/main`);
          await page.getByText("Final review is ready.", { exact: true }).waitFor();
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          const image = page.locator(".chat-message-image");
          await image.evaluate((element) => (element as HTMLImageElement).decode());
          const summaries = page.locator(".chat-activity-group__summary");
          expect(await summaries.count()).toBe(4);
          await summaries.first().focus();
          await page.keyboard.press("Enter");
          await expect.poll(() => summaries.first().getAttribute("aria-expanded")).toBe("true");
          await page.keyboard.press("Enter");
          await expect.poll(() => summaries.first().getAttribute("aria-expanded")).toBe("false");
          expect(
            await summaries.first().evaluate((element) => element === document.activeElement),
          ).toBe(true);

          const measure = async () => {
            await page.locator(".chat-thread").evaluate((element) => {
              element.scrollTop = 0;
            });
            await waitForChatScrollIdle(page);
            return page.evaluate(() => {
              const groups = [...document.querySelectorAll(".chat-thread .chat-group")];
              const group = (text: string) =>
                groups.find((element) => element.textContent?.includes(text))!;
              const first = group("The first file is ready.");
              const media = group("Please include this preview");
              const peer = group("I checked the preview.");
              const own = group("Thank you.");
              const content = (element: Element) =>
                element.querySelector(":scope > .chat-group-messages")!;
              const rect = (element: Element) => element.getBoundingClientRect();
              const blocks = [...content(first).children].filter(
                (element) => rect(element).height > 0,
              );
              const paragraphs = [...first.querySelectorAll(".chat-text > p")];
              const img = rect(media.querySelector(".chat-message-image")!);
              const file = rect(media.querySelector(".chat-assistant-attachment-card")!);
              return {
                imageWidth: img.width,
                imageHeight: img.height,
                imageToFile: file.top - img.bottom,
                fileToText: rect(media.querySelector(".chat-text > p")!).top - file.bottom,
                runGaps: blocks
                  .slice(1)
                  .map((element, index) => rect(element).top - rect(blocks[index]!).bottom)
                  .slice(1),
                summaryToText:
                  rect(paragraphs[0]!).top -
                  rect(first.querySelector(".chat-activity-group__summary")!).bottom,
                paragraphGap: rect(paragraphs.at(-1)!).top - rect(paragraphs.at(-2)!).bottom,
                ownToPeer: rect(content(peer)).top - rect(content(media)).bottom,
                peerToOwn: rect(content(own)).top - rect(content(peer)).bottom,
                footerHeight: rect(peer.querySelector(".chat-group-footer")!).height,
                firstHeight: rect(first).height,
              };
            });
          };
          const assertRhythm = async () => {
            const measured = await measure();
            expect(measured.imageHeight).toBe(120);
            expect(measured.imageWidth).toBe(320);
            expect(measured.runGaps).toEqual([8, 8, 8, 8, 8]);
            expect(measured.paragraphGap).toBe(14);
            expect(measured.imageToFile).toBe(14);
            expect(measured.fileToText).toBe(24);
            expect(measured.ownToPeer).toBe(width === 390 ? 30 : 28);
            expect(measured.peerToOwn).toBe(width === 390 ? 30 : 28);
            expect(measured.footerHeight).toBe(width === 390 ? 24 : 26);
            return measured;
          };
          expect((await assertRhythm()).summaryToText).toBe(12);
          for (const summary of await summaries.all()) {
            await summary.focus();
            await page.keyboard.press("Enter");
            await expect.poll(() => summary.getAttribute("aria-expanded")).toBe("true");
          }
          const expanded = await assertRhythm();
          await page
            .locator(".agent-chat__composer-combobox textarea")
            .fill("Continue the review.");
          await page.getByRole("button", { name: "Send message", exact: true }).click();
          const request = await gateway.waitForRequest("chat.send");
          await gateway.emitGatewayEvent("chat", {
            state: "delta",
            sessionKey: "agent:main:main",
            runId: requireString(requireRecord(request.params).idempotencyKey, "chat run ID"),
            deltaText: "Checking the final details.",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Checking the final details." }],
              timestamp: 1789552800000,
            },
          });
          await page.locator(".chat-bubble.streaming").waitFor();
          expect((await assertRhythm()).firstHeight).toBe(expanded.firstHeight);
        },
      );
    },
  );
});
