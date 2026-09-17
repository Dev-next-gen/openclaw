import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// July discovers bundled CLI owners through this lightweight entry, not the
// newer cliCommands manifest field. Keep migration code lazy until invocation.
export default definePluginEntry({
  id: "file-transfer",
  name: "File Transfer",
  description: "Review file-transfer standing approvals",
  register(api) {
    api.registerCli(
      async ({ program }) => {
        const { registerFileTransferCli } = await import("./src/cli.js");
        registerFileTransferCli(program);
      },
      {
        descriptors: [
          {
            name: "file-transfer",
            description: "Review file-transfer standing approvals",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
