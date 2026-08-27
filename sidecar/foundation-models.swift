#!/usr/bin/env swift

import Foundation

#if canImport(FoundationModels)
import FoundationModels

// Struct for JSON requests from Node.js
struct CompressionRequest: Codable {
    let text: String
    let systemPrompt: String
    let maxTokens: Int
}

// Struct for JSON responses to Node.js
struct CompressionResponse: Codable {
    let compressedText: String
    let originalLength: Int
    let compressedLength: Int
    let error: String?
}

func compressText(request: CompressionRequest) -> CompressionResponse {
    do {
        // Create language model instance
        let configuration = ModelConfiguration()
        let model = try SystemLanguageModel(configuration: configuration)

        // Build prompt
        let prompt = "\(request.systemPrompt)\n\nText:\n\(request.text)"

        // Generate response
        let constraints = ModelConstraints(tokenLimit: request.maxTokens)
        let input = LanguageModelInput(prompt)
        let response = try model.generate(input, constraints: constraints)

        // Extract compressed text
        guard let compressedText = response?.first?.content else {
            return CompressionResponse(
                compressedText: "",
                originalLength: request.text.count,
                compressedLength: 0,
                error: "No response from model"
            )
        }

        return CompressionResponse(
            compressedText: compressedText,
            originalLength: request.text.count,
            compressedLength: compressedText.count,
            error: nil
        )
    } catch {
        return CompressionResponse(
            compressedText: "",
            originalLength: request.text.count,
            compressedLength: 0,
            error: error.localizedDescription
        )
    }
}

// Main loop: read JSON from stdin, write JSON to stdout
func main() {
    let stdin = FileHandle.standardInput
    let stdout = FileHandle.standardOutput
    let decoder = JSONDecoder()
    let encoder = JSONEncoder()

    while true {
        // Read line from stdin (JSON request)
        guard let line = try? stdin.availableData,
              let request = try? decoder.decode(CompressionRequest.self, from: line) else {
            continue
        }

        // Process compression
        let response = compressText(request: request)

        // Write response to stdout (JSON)
        if let responseData = try? encoder.encode(response) {
            stdout.write(responseData)
            stdout.write(Data([0x0A])) // newline
        } else {
            // Fallback: write error line
            let errorLine = "ERROR: \(response.error ?? "encoding failed")\n"
            if let errorData = errorLine.data(using: .utf8) {
                stdout.write(errorData)
            }
        }

        fflush(stdout)
    }
}

main()

#else
import Foundation

// Fallback: FoundationModels not available (wrong macOS version)
func main() {
    let stdout = FileHandle.standardOutput
    let errorMessage = """
    {"error":"FoundationModels framework not available. Requires macOS 15.0+ (Sequoia).","compressedText":"","originalLength":0,"compressedLength":0}
    """
    if let errorData = errorMessage.data(using: .utf8) {
        stdout.write(errorData)
    }
}

main()
#endif
