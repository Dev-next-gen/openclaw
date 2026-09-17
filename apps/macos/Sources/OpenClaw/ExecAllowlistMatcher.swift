import Foundation
import JavaScriptCore

enum ExecAllowlistMatcher {
    static func match(entries: [ExecAllowlistEntry], resolution: ExecCommandResolution?) -> ExecAllowlistEntry? {
        guard let resolution, !entries.isEmpty else { return nil }
        let rawExecutable = resolution.rawExecutable
        let resolvedPath = resolution.resolvedPath

        for entry in entries {
            guard self.matchesArguments(entry: entry, resolution: resolution) else { continue }
            switch ExecApprovalHelpers.validateAllowlistPattern(entry.pattern) {
            case let .valid(pattern):
                if ExecApprovalHelpers.patternHasPathSelector(pattern) {
                    let target = resolvedPath ?? rawExecutable
                    if self.matches(pattern: pattern, target: target) { return entry }
                } else if pattern != "*",
                          !ExecApprovalHelpers.patternHasPathSelector(rawExecutable),
                          self.matchesExecutableBasename(pattern: pattern, resolution: resolution)
                {
                    return entry
                }
            case .invalid:
                continue
            }
        }
        return nil
    }

    private static func matchesArguments(entry: ExecAllowlistEntry, resolution: ExecCommandResolution) -> Bool {
        let pattern = entry.pattern.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !pattern.hasPrefix("=command:"), !pattern.hasPrefix("=node-command:") else { return false }
        guard let argPattern = entry.argPattern, !argPattern.isEmpty else {
            return entry.source != "allow-always"
        }
        let cwdPrefix = "sha256:cwd-argv:v1:"
        if entry.source == "allow-always", !argPattern.hasPrefix(cwdPrefix) { return false }
        guard resolution.reusableArgumentsSafe, let argv = resolution.argv else { return false }
        if argPattern.hasPrefix(cwdPrefix) {
            guard let cwd = resolution.cwd else { return false }
            return argPattern == ExecCommandResolution.cwdBoundArgPattern(argv: argv, cwd: cwd)
        }
        if argPattern.hasPrefix("sha256:argv:") { return false }
        let arguments = Array(argv.dropFirst())
        let nul = "\0"
        let subject = argPattern.contains(nul)
            ? (arguments.isEmpty ? nul + nul : arguments.joined(separator: nul) + nul)
            : arguments.joined(separator: " ")
        // Shared manual arg patterns use JavaScript RegExp, not ICU semantics.
        guard let context = JSContext(), let constructor = context.objectForKeyedSubscript("RegExp"),
              let regex = constructor.construct(withArguments: [argPattern]), context.exception == nil,
              let result = regex.invokeMethod("test", withArguments: [subject]), context.exception == nil
        else { return false }
        return result.toBool()
    }

    static func matchAll(
        entries: [ExecAllowlistEntry],
        resolutions: [ExecCommandResolution]) -> [ExecAllowlistEntry]
    {
        guard !entries.isEmpty, !resolutions.isEmpty else { return [] }
        var matches: [ExecAllowlistEntry] = []
        matches.reserveCapacity(resolutions.count)
        for resolution in resolutions {
            guard let match = self.match(entries: entries, resolution: resolution) else {
                return []
            }
            matches.append(match)
        }
        return matches
    }

    private static func matchesExecutableBasename(
        pattern: String,
        resolution: ExecCommandResolution) -> Bool
    {
        var candidates = Set<String>()
        if !resolution.executableName.isEmpty {
            candidates.insert(resolution.executableName)
        }
        if let resolvedPath = resolution.resolvedPath, !resolvedPath.isEmpty {
            candidates.insert(URL(fileURLWithPath: resolvedPath).lastPathComponent)
        }
        return candidates.contains { self.matches(pattern: pattern, target: $0) }
    }

    private static func matches(pattern: String, target: String) -> Bool {
        let trimmed = pattern.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let expanded = trimmed.hasPrefix("~") ? (trimmed as NSString).expandingTildeInPath : trimmed
        let normalizedPattern = self.normalizeMatchTarget(expanded)
        let normalizedTarget = self.normalizeMatchTarget(target)
        guard let regex = self.regex(for: normalizedPattern) else { return false }
        let range = NSRange(location: 0, length: normalizedTarget.utf16.count)
        return regex.firstMatch(in: normalizedTarget, options: [], range: range) != nil
    }

    private static func normalizeMatchTarget(_ value: String) -> String {
        value.replacingOccurrences(of: "\\\\", with: "/").lowercased()
    }

    private static func regex(for pattern: String) -> NSRegularExpression? {
        var regex = "^"
        var idx = pattern.startIndex
        while idx < pattern.endIndex {
            let ch = pattern[idx]
            if ch == "*" {
                let next = pattern.index(after: idx)
                if next < pattern.endIndex, pattern[next] == "*" {
                    regex += ".*"
                    idx = pattern.index(after: next)
                } else {
                    regex += "[^/]*"
                    idx = next
                }
                continue
            }
            if ch == "?" {
                regex += "."
                idx = pattern.index(after: idx)
                continue
            }
            regex += NSRegularExpression.escapedPattern(for: String(ch))
            idx = pattern.index(after: idx)
        }
        regex += "$"
        return try? NSRegularExpression(pattern: regex, options: [.caseInsensitive])
    }
}
