import type { Page } from "playwright";
import { projectChatDisplayMessages } from "../../../src/gateway/chat-display-projection.js";
import type { ControlUiMockGatewayScenario } from "../test-helpers/control-ui-e2e.ts";

const longText = `${"Please review the sample release checklist and explain the next useful step. ".repeat(17)}End of request.`;
const marginImageSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="teal"/><circle cx="480" cy="270" r="160" fill="gold"/></svg>';
const imageUrl = `data:image/svg+xml,${encodeURIComponent(marginImageSvg)}`;
const image = { type: "image", url: imageUrl, width: 960, height: 540 };
const file = {
  type: "attachment",
  attachment: {
    kind: "document",
    label: "release-checklist-with-a-long-file-name.txt",
    mimeType: "text/plain",
    url: "https://example.com/checklist.txt",
    sizeBytes: 1024,
  },
};
const video = {
  type: "attachment",
  attachment: {
    kind: "video",
    url: "https://media.example/preview.mp4",
    mimeType: "video/mp4",
    label: "preview.mp4",
  },
};
const audio = {
  type: "attachment",
  attachment: {
    kind: "audio",
    url: "https://media.example/preview.mp3",
    mimeType: "audio/mpeg",
    label: "preview.mp3",
  },
};
const users = ["Riley", "Colin"].map((name, index) => ({
  id: name,
  name,
  self: index === 0,
  identity: { type: "profile" as const, id: name },
}));
const message = (role: string, content: unknown, extra = {}) => ({
  role,
  content,
  timestamp: 1_800_000_000_000,
  ...extra,
});
const forwarded = (sourceSessionKey: string, content: unknown) =>
  projectChatDisplayMessages([
    message("user", content, {
      provenance: { kind: "inter_session", sourceSessionKey, sourceTool: "sessions_send" },
    }),
  ]);

export const marginCases = [
  {
    id: "user-long",
    messages: [message("user", longText)],
    side: "right",
    selector: ".chat-bubble",
  },
  {
    id: "user-short",
    messages: [message("user", "Ready.")],
    side: "right",
    selector: ".chat-bubble",
  },
  {
    id: "peer-long",
    messages: [
      message("user", longText, {
        __openclaw: { senderId: "Colin", senderIdentity: users[1]!.identity, senderName: "Colin" },
      }),
    ],
    side: "left",
    selector: ".chat-bubble",
  },
  ...["user", "assistant"].flatMap((role) =>
    [
      {
        id: `${role}-file`,
        content: [file, { type: "text", text: "Please read this checklist." }],
        selector: ".chat-assistant-attachment-card",
      },
      { id: `${role}-image`, content: [image], selector: ".chat-message-image" },
      {
        id: `${role}-video`,
        content: [video],
        selector: role === "user" ? ".chat-video-preview" : ".chat-assistant-attachment-card",
      },
      { id: `${role}-audio`, content: [audio], selector: ".chat-assistant-attachment-card" },
    ].map(({ id, content, selector }) => ({
      id,
      messages: [message(role, content)],
      side: role === "user" ? "right" : "left",
      selector,
    })),
  ),
  ...[2, 3, 5].map((count) => ({
    id: `user-gallery-${count}`,
    messages: [
      message(
        "user",
        Array.from({ length: count }, () => image),
      ),
    ],
    side: "right",
    selector: ".chat-message-images",
  })),
  {
    id: "peer-gallery",
    messages: [
      message("user", [image, image, image], {
        __openclaw: { senderId: "Colin", senderIdentity: users[1]!.identity, senderName: "Colin" },
      }),
    ],
    side: "left",
    selector: ".chat-message-images",
  },
  {
    id: "user-mixed",
    messages: [message("user", [image, video, file, { type: "text", text: longText }])],
    side: "right",
    selector: ".chat-bubble",
  },
  ...[
    "agent:main:cron:release-review",
    "agent:research:notes",
    "agent:main:subagent:checklist",
    "legacy-checklist",
  ].map((key, index) => ({
    id: ["forwarded", "other-agent", "subagent", "legacy"][index]!,
    messages: forwarded(key, longText),
    side: "left",
    selector: ".chat-bubble",
  })),
  {
    id: "forwarded-short",
    messages: forwarded("agent:main:cron:release-review", "Review complete."),
    side: "left",
    selector: ".chat-bubble",
  },
  {
    id: "forwarded-media",
    messages: forwarded("agent:research:notes", [
      { ...image, url: "https://media.example/preview.png" },
      file,
      { type: "text", text: "The sample checklist is ready." },
    ]),
    side: "left",
    selector: ".chat-bubble",
  },
  {
    id: "question",
    messages: [
      message("assistant", "Which audience should the summary address?", {
        openclawAsyncDelivery: {
          itemId: "audience",
          questions: [
            {
              title: "Which audience should the detailed release summary address?",
              options: ["Engineers", "Everyone"],
            },
          ],
        },
      }),
    ],
    side: "left",
    selector: ".chat-question-panel",
  },
  {
    id: "clawhub",
    messages: [
      message("assistant", [
        {
          type: "clawhub",
          kind: "plugin",
          id: "ch_sample",
          official: true,
          name: "Sample checklist plugin",
          description: "Review and share sample release checklists with your team.",
          installed: false,
        },
      ]),
    ],
    side: "left",
    selector: ".chat-clawhub-card",
  },
  {
    id: "assistant-plain",
    messages: [
      message(
        "assistant",
        "A plain assistant response with a long line that should keep the full conversation width. ".repeat(
          4,
        ),
      ),
    ],
    side: "left",
    selector: ".chat-bubble",
    excluded: true,
  },
  {
    id: "system-notice",
    messages: [message("system", "The sample session is ready.")],
    side: "left",
    selector: ".chat-notice",
    excluded: true,
  },
] as const;

export type MarginCase = (typeof marginCases)[number];

export function marginScenario(testCase: MarginCase): ControlUiMockGatewayScenario {
  return {
    historyMessages: [...testCase.messages],
    presenceUsers: users,
    methodResponses: {
      "plugins.catalog.get": {
        plugin: {
          id: "ch_sample",
          catalog: {
            name: "Sample checklist plugin",
            summary: "Review and share sample release checklists with your team.",
          },
          local: { installed: false, action: "install" },
        },
      },
    },
  };
}

export async function createMarginImage(page: Page): Promise<Buffer> {
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 540;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "teal";
    context.fillRect(0, 0, 960, 540);
    context.fillStyle = "gold";
    context.beginPath();
    context.arc(480, 270, 160, 0, 2 * Math.PI);
    context.fill();
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  return Buffer.from(encoded, "base64");
}

export async function measureMargin(page: Page, testCase: MarginCase) {
  const target = page.locator(`.chat-thread ${testCase.selector}`).first();
  await target.waitFor();
  await page
    .locator(".chat-thread img.chat-message-image")
    .evaluateAll((images: HTMLImageElement[]) =>
      Promise.all(images.map((element) => element.decode())),
    );
  await page.evaluate(() => document.fonts.ready);
  return target.evaluate((element, side) => {
    const group = element.closest(".chat-group") ?? element.closest(".chat-thread-inner")!;
    const column = group.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const media = [...element.querySelectorAll(".chat-image-frame, img.chat-message-image, video")]
      .map((item) => item.getBoundingClientRect())
      .filter((rect) => rect.width > 0);
    const left = Math.min(box.left, ...media.map((rect) => rect.left));
    const right = Math.max(box.right, ...media.map((rect) => rect.right));
    return {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      columnWidth: column.width,
      open: side === "right" ? left - column.left : column.right - right,
      closed: side === "right" ? column.right - right : left - column.left,
      overflow: Math.max(0, element.scrollWidth - element.clientWidth),
      padding: style.padding,
      radius: style.borderRadius,
      background: style.backgroundColor,
      media: [...element.querySelectorAll("img, video")].map((mediaElement) => {
        const rect = mediaElement.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          left: rect.left - box.left,
          right: box.right - rect.right,
        };
      }),
    };
  }, testCase.side);
}
