import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct ExecApprovalsStoreRefactorTests {
    private var realTemporaryDirectory: URL {
        let path = FileManager().temporaryDirectory.path
        if path.hasPrefix("/var/") {
            return URL(fileURLWithPath: "/private\(path)", isDirectory: true)
        }
        return FileManager().temporaryDirectory.resolvingSymlinksInPath()
    }

    private func withLockedEnv(
        _ values: [String: String?],
        _ body: () async throws -> Void) async throws
    {
        func restoreEnv(_ values: [String: String?]) {
            for (key, value) in values {
                if let value {
                    setenv(key, value, 1)
                } else {
                    unsetenv(key)
                }
            }
        }

        await TestIsolationLock.shared.acquire()
        var previousEnv: [String: String?] = [:]
        for (key, value) in values {
            previousEnv[key] = getenv(key).map { String(cString: $0) }
            if let value {
                setenv(key, value, 1)
            } else {
                unsetenv(key)
            }
        }

        do {
            try await body()
            restoreEnv(previousEnv)
            await TestIsolationLock.shared.release()
        } catch {
            restoreEnv(previousEnv)
            await TestIsolationLock.shared.release()
            throw error
        }
    }

    private func withTempStateDir(
        _ body: @escaping @Sendable (URL) async throws -> Void) async throws
    {
        let root = self.realTemporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
        let home = root.appendingPathComponent("home", isDirectory: true)
        let stateDir = root.appendingPathComponent("state", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        try Self.seedCurrentApprovalsFile(in: stateDir)

        try await self.withLockedEnv([
            "OPENCLAW_HOME": home.path,
            "OPENCLAW_STATE_DIR": stateDir.path,
        ]) {
            try await body(stateDir)
        }
    }

    private func withTempHomeAndStateDir(
        _ body: @escaping @Sendable (URL, URL) async throws -> Void) async throws
    {
        let root = self.realTemporaryDirectory
            .appendingPathComponent("openclaw-home-state-\(UUID().uuidString)", isDirectory: true)
        let home = root.appendingPathComponent("home", isDirectory: true)
        let stateDir = root.appendingPathComponent("state", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }

        try await self.withLockedEnv([
            "OPENCLAW_HOME": home.path,
            "OPENCLAW_STATE_DIR": stateDir.path,
        ]) {
            try await body(home, stateDir)
        }
    }

    @Test
    func `ensure file skips rewrite when unchanged`() async throws {
        try await self.withTempStateDir { _ in
            _ = ExecApprovalsStore.ensureFile()
            let url = ExecApprovalsStore.fileURL()
            let firstIdentity = try Self.fileIdentity(at: url)

            _ = ExecApprovalsStore.ensureFile()
            let secondIdentity = try Self.fileIdentity(at: url)

            #expect(firstIdentity == secondIdentity)
        }
    }

    @Test
    func `ensure file migrates default approvals into custom state dir`() async throws {
        try await self.withTempHomeAndStateDir { home, stateDir in
            let legacyDir = home.appendingPathComponent(".openclaw", isDirectory: true)
            try FileManager().createDirectory(
                at: legacyDir,
                withIntermediateDirectories: true)
            let legacySocket = legacyDir.appendingPathComponent("exec-approvals.sock").path
            let legacyFile = legacyDir.appendingPathComponent("exec-approvals.json")
            let legacyJson = """
            {
              "version": 1,
              "socket": {
                "path": "\(legacySocket)",
                "token": "legacy-token"
              },
              "defaults": {
                "security": "deny",
                "ask": "always"
              },
              "agents": {
                "main": {
                  "allowlist": [{ "pattern": "git status" }]
                }
              }
            }
            """
            try Data(legacyJson.utf8).write(to: legacyFile)

            let file = ExecApprovalsStore.ensureFile()
            let targetURL = ExecApprovalsStore.fileURL()

            #expect(targetURL.path == stateDir.appendingPathComponent("exec-approvals.json").path)
            #expect(FileManager().fileExists(atPath: targetURL.path))
            #expect(file.socket?.path == stateDir.appendingPathComponent("exec-approvals.sock").path)
            #expect(file.socket?.token == "legacy-token")
            #expect(file.defaults?.security == .deny)
            #expect(file.defaults?.ask == .always)
            #expect(file.agents?["main"]?.allowlist?.map(\.pattern) == ["git status"])
            #expect(!FileManager().fileExists(atPath: legacyFile.path))
            #expect(FileManager().fileExists(atPath: "\(legacyFile.path).migrated"))
        }
    }

    @Test
    func `update allowlist accepts basename pattern`() async throws {
        try await self.withTempStateDir { _ in
            let rejected = ExecApprovalsStore.updateAllowlist(
                agentId: "main",
                allowlist: [
                    ExecAllowlistEntry(pattern: "echo"),
                    ExecAllowlistEntry(pattern: "/bin/echo"),
                ])
            #expect(rejected.isEmpty)

            let resolved = ExecApprovalsStore.resolve(agentId: "main")
            #expect(resolved.allowlist.map(\.pattern) == ["echo", "/bin/echo"])
        }
    }

    @Test
    func `update allowlist migrates legacy pattern from resolved path`() async throws {
        try await self.withTempStateDir { _ in
            let rejected = ExecApprovalsStore.updateAllowlist(
                agentId: "main",
                allowlist: [
                    ExecAllowlistEntry(
                        pattern: "echo",
                        lastUsedAt: nil,
                        lastUsedCommand: nil,
                        lastResolvedPath: " /usr/bin/echo "),
                ])
            #expect(rejected.isEmpty)

            let resolved = ExecApprovalsStore.resolve(agentId: "main")
            #expect(resolved.allowlist.map(\.pattern) == ["/usr/bin/echo"])
        }
    }

    @Test
    func `store preserves distinct generated bindings when recording usage`() async throws {
        try await self.withTempStateDir { _ in
            for argPattern in ["sha256:cwd-argv:v1:one", "sha256:cwd-argv:v1:two"] {
                ExecApprovalsStore.addAllowlistEntry(
                    agentId: "main",
                    pattern: "/usr/bin/printf",
                    source: "allow-always",
                    argPattern: argPattern)
            }
            ExecApprovalsStore.recordAllowlistUse(
                agentId: "main",
                pattern: "/usr/bin/printf",
                command: "printf safe",
                resolvedPath: "/usr/bin/printf")
            let entries = try #require(ExecApprovalsStore.loadFile().agents?["main"]?.allowlist)
            #expect(entries.count == 2)
            #expect(entries.allSatisfy { $0.source == "allow-always" })
            #expect(Set(entries.compactMap(\.argPattern)) ==
                Set(["sha256:cwd-argv:v1:one", "sha256:cwd-argv:v1:two"]))
        }
    }

    @Test
    func `cleanup removes obsolete generated approvals but preserves manual and current rules`() async throws {
        try await self.withTempStateDir { _ in
            ExecApprovalsStore.saveFile(ExecApprovalsFile(version: 1, agents: ["main": ExecApprovalsAgent(allowlist: [
                ExecAllowlistEntry(pattern: "/usr/bin/git", source: "allow-always"),
                ExecAllowlistEntry(
                    pattern: "/usr/bin/curl",
                    source: "allow-always",
                    argPattern: "sha256:argv:obsolete"),
                ExecAllowlistEntry(
                    pattern: "/usr/bin/rg",
                    source: "allow-always",
                    argPattern: "sha256:cwd-argv:v1:current"),
                ExecAllowlistEntry(pattern: "/usr/bin/python3", argPattern: #"^script\.py$"#),
                ExecAllowlistEntry(pattern: "=node-command:marker", source: "allow-always"),
            ])]))

            let removed = ExecApprovalsStore.removeObsoleteGeneratedAllowAlwaysEntries()
            let entries = try #require(ExecApprovalsStore.loadFile().agents?["main"]?.allowlist)

            #expect(removed == 2)
            #expect(entries.map(\.pattern) == [
                "/usr/bin/rg",
                "/usr/bin/python3",
                "=node-command:marker",
            ])
        }
    }

    @Test
    func `ensure file hardens state directory permissions`() async throws {
        try await self.withTempStateDir { stateDir in
            try FileManager().createDirectory(at: stateDir, withIntermediateDirectories: true)
            try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: stateDir.path)

            _ = ExecApprovalsStore.ensureFile()
            let attrs = try FileManager().attributesOfItem(atPath: stateDir.path)
            let permissions = (attrs[.posixPermissions] as? NSNumber)?.intValue ?? -1
            #expect(permissions & 0o777 == 0o700)
        }
    }

    private static func fileIdentity(at url: URL) throws -> Int {
        let attributes = try FileManager().attributesOfItem(atPath: url.path)
        guard let identifier = (attributes[.systemFileNumber] as? NSNumber)?.intValue else {
            struct MissingIdentifierError: Error {}
            throw MissingIdentifierError()
        }
        return identifier
    }

    private static func seedCurrentApprovalsFile(in stateDir: URL) throws {
        try FileManager().createDirectory(at: stateDir, withIntermediateDirectories: true)
        let file = ExecApprovalsFile(
            version: 1,
            socket: ExecApprovalsSocketConfig(
                path: stateDir.appendingPathComponent("exec-approvals.sock").path,
                token: "test-token"),
            defaults: nil,
            agents: [:])
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(file)
            .write(to: stateDir.appendingPathComponent("exec-approvals.json"))
    }
}
