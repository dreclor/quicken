// On-device Apple Foundation Models bridge. No cloud fallback.
import Foundation
import FoundationModels

struct Request: Decodable {
    let id: Int
    let op: String
    let system: String?
    let input: String?
    let schema: String?
    let maxTokens: Int?
    let seed: UInt64?
}

struct BridgeError: Error, CustomStringConvertible {
    let description: String
}

func emit(_ value: [String: Any]) {
    do {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    } catch {
        FileHandle.standardError.write(Data("Could not encode model response: \(error)\n".utf8))
    }
}

// The property order is sent separately because JSON dictionaries do not preserve it.
func dynamicSchema(_ raw: [String: Any], name: String) throws -> DynamicGenerationSchema {
    if let choices = raw["enum"] as? [String] {
        return DynamicGenerationSchema(name: name, anyOf: choices)
    }
    switch raw["type"] as? String {
    case "string": return DynamicGenerationSchema(type: String.self)
    case "number": return DynamicGenerationSchema(type: Double.self)
    case "integer": return DynamicGenerationSchema(type: Int.self)
    case "boolean": return DynamicGenerationSchema(type: Bool.self)
    case "array":
        guard let item = raw["items"] as? [String: Any] else { throw BridgeError(description: "Missing array item schema") }
        return try DynamicGenerationSchema(arrayOf: dynamicSchema(item, name: name + "Item"), minimumElements: raw["minItems"] as? Int, maximumElements: raw["maxItems"] as? Int)
    case "object":
        guard let properties = raw["properties"] as? [String: [String: Any]],
              let order = raw["propertyOrder"] as? [String], Set(order) == Set(properties.keys) else {
            throw BridgeError(description: "Missing object properties or property order")
        }
        let required = Set(raw["required"] as? [String] ?? [])
        let fields = try order.map { key in
            DynamicGenerationSchema.Property(name: key, schema: try dynamicSchema(properties[key]!, name: name + "_" + key), isOptional: !required.contains(key))
        }
        return DynamicGenerationSchema(name: name, properties: fields)
    default: throw BridgeError(description: "Unsupported schema type")
    }
}

func schemaFor(_ json: String?) throws -> GenerationSchema? {
    guard let json else { return nil }
    guard let raw = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else {
        throw BridgeError(description: "Expected a JSON schema object")
    }
    return try GenerationSchema(root: dynamicSchema(raw, name: "QuickenResult"), dependencies: [])
}

@main
struct AppleModelBridge {
    static func main() async {
        let model = SystemLanguageModel.default
        while let line = readLine() {
            var id = 0
            let start = ContinuousClock.now
            do {
                let request = try JSONDecoder().decode(Request.self, from: Data(line.utf8))
                id = request.id
                if request.op == "availability" {
                    let available: Bool
                    if case .available = model.availability { available = true } else { available = false }
                    let reason: String
                    switch model.availability {
                    case .available: reason = "available"
                    case .unavailable(.appleIntelligenceNotEnabled): reason = "disabled"
                    case .unavailable(.deviceNotEligible): reason = "unsupported"
                    case .unavailable(.modelNotReady): reason = "notReady"
                    default: reason = "unavailable"
                    }
                    emit(["reason": reason, "id": id, "ok": true, "available": available, "availability": String(describing: model.availability), "os": ProcessInfo.processInfo.operatingSystemVersionString, "contextSize": model.contextSize, "model": "SystemLanguageModel.default (on-device)"])
                    continue
                }
                let schema = try schemaFor(request.schema)
                if request.op == "validateSchema" {
                    emit(["id": id, "ok": true, "schemaValidated": schema != nil])
                    continue
                }
                guard request.op == "complete" else { throw BridgeError(description: "Unknown operation") }
                guard case .available = model.availability else { throw BridgeError(description: "Apple model unavailable: \(model.availability)") }
                guard let system = request.system, let input = request.input else { throw BridgeError(description: "Missing prompt") }
                let session = LanguageModelSession(model: model, instructions: system)
                let options = GenerationOptions(sampling: .random(top: 40, seed: request.seed), temperature: 0.1, maximumResponseTokens: request.maxTokens ?? 320)
                let text: String
                if let schema {
                    text = try await session.respond(to: input, schema: schema, options: options).content.jsonString
                } else {
                    text = try await session.respond(to: input, options: options).content
                }
                let elapsed = start.duration(to: .now)
                emit(["id": id, "ok": true, "text": text, "ms": Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15])
            } catch {
                let elapsed = start.duration(to: .now)
                emit(["id": id, "ok": false, "error": String(describing: error), "ms": Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15])
            }
        }
    }
}
