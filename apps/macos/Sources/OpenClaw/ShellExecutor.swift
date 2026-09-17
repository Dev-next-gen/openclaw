import Foundation
import OpenClawIPC

enum ShellExecutor {
    struct ShellResult {
        var stdout: String
        var stderr: String
        var exitCode: Int?
        var timedOut: Bool
        var success: Bool
        var errorMessage: String?
        var preflightError: String?
    }

    private final class CompletionBox: @unchecked Sendable {
        private let lock = NSLock()
        private var finished = false
        private let continuation: CheckedContinuation<ShellResult, Never>

        init(continuation: CheckedContinuation<ShellResult, Never>) {
            self.continuation = continuation
        }

        func finish(_ result: ShellResult) {
            self.lock.lock()
            defer { self.lock.unlock() }
            guard !self.finished else { return }
            self.finished = true
            self.continuation.resume(returning: result)
        }
    }

    private static func completedResult(
        status: Int,
        outTask: Task<Data, Never>,
        errTask: Task<Data, Never>) async -> ShellResult
    {
        let out = await outTask.value
        let err = await errTask.value
        return ShellResult(
            stdout: String(bytes: out, encoding: .utf8) ?? "",
            stderr: String(bytes: err, encoding: .utf8) ?? "",
            exitCode: status,
            timedOut: false,
            success: status == 0,
            errorMessage: status == 0 ? nil : "exit \(status)")
    }

    static func runDetailed(
        command: [String],
        cwd: String?,
        env: [String: String]?,
        timeout: Double?,
        beforeSpawn: (@Sendable () -> String?)? = nil) async -> ShellResult
    {
        guard !command.isEmpty else {
            return ShellResult(
                stdout: "",
                stderr: "",
                exitCode: nil,
                timedOut: false,
                success: false,
                errorMessage: "empty command")
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = command
        if let cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        if let env { process.environment = env }

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        let outTask = Task { stdoutPipe.fileHandleForReading.readToEndSafely() }
        let errTask = Task { stderrPipe.fileHandleForReading.readToEndSafely() }

        if let timeout, timeout > 0 {
            return await withCheckedContinuation { continuation in
                let completion = CompletionBox(continuation: continuation)

                process.terminationHandler = { terminatedProcess in
                    let status = Int(terminatedProcess.terminationStatus)
                    Task {
                        let result = await self.completedResult(
                            status: status,
                            outTask: outTask,
                            errTask: errTask)
                        completion.finish(result)
                    }
                }

                if let message = beforeSpawn?() {
                    stdoutPipe.fileHandleForWriting.closeFile()
                    stderrPipe.fileHandleForWriting.closeFile()
                    completion.finish(ShellResult(
                        stdout: "",
                        stderr: "",
                        exitCode: nil,
                        timedOut: false,
                        success: false,
                        errorMessage: message,
                        preflightError: message))
                    return
                }
                do {
                    try process.run()
                } catch {
                    completion.finish(
                        ShellResult(
                            stdout: "",
                            stderr: "",
                            exitCode: nil,
                            timedOut: false,
                            success: false,
                            errorMessage: "failed to start: \(error.localizedDescription)"))
                    return
                }

                DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + timeout) {
                    guard process.isRunning else { return }
                    process.terminate()
                    completion.finish(
                        ShellResult(
                            stdout: "",
                            stderr: "",
                            exitCode: nil,
                            timedOut: true,
                            success: false,
                            errorMessage: "timeout"))
                }
            }
        }

        if let message = beforeSpawn?() {
            stdoutPipe.fileHandleForWriting.closeFile()
            stderrPipe.fileHandleForWriting.closeFile()
            return ShellResult(
                stdout: "",
                stderr: "",
                exitCode: nil,
                timedOut: false,
                success: false,
                errorMessage: message,
                preflightError: message)
        }
        do {
            try process.run()
        } catch {
            return ShellResult(
                stdout: "",
                stderr: "",
                exitCode: nil,
                timedOut: false,
                success: false,
                errorMessage: "failed to start: \(error.localizedDescription)")
        }

        process.waitUntilExit()
        return await self.completedResult(
            status: Int(process.terminationStatus),
            outTask: outTask,
            errTask: errTask)
    }

    static func run(command: [String], cwd: String?, env: [String: String]?, timeout: Double?) async -> Response {
        let result = await self.runDetailed(command: command, cwd: cwd, env: env, timeout: timeout)
        let combined = result.stdout.isEmpty ? result.stderr : result.stdout
        let payload = combined.isEmpty ? nil : Data(combined.utf8)
        return Response(ok: result.success, message: result.errorMessage, payload: payload)
    }
}
