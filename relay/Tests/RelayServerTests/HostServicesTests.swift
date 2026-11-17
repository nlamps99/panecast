import XCTest
import Foundation
import SharedKit
@testable import RelayServer

final class HostServicesTests: XCTestCase {
    func testBatteryParserReadsPercentStateAndPowerSource() {
        let output = """
        Now drawing from 'Battery Power'
         -InternalBattery-0 (id=1234567)\t82%; discharging; 4:11 remaining present: true
        """

        let battery = HostBatteryService.parse(pmsetOutput: output)

        XCTAssertTrue(battery.available)
        XCTAssertEqual(battery.percent, 82)
        XCTAssertEqual(battery.state, "discharging")
        XCTAssertEqual(battery.powerSource, "Battery Power")
        XCTAssertEqual(battery.isCharging, false)
    }

    func testBatteryParserHandlesNoBattery() {
        let battery = HostBatteryService.parse(pmsetOutput: "Now drawing from 'AC Power'\nNo batteries installed\n")

        XCTAssertFalse(battery.available)
        XCTAssertNil(battery.percent)
        XCTAssertEqual(battery.powerSource, "AC Power")
    }

    func testFileUploadWritesOnlyInsideDownloadsCmuxRemote() throws {
        let data = Data([1, 2, 3])
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let result = try RelayFileUploadService.save(
            params: .object([
                "filename": .string("../bad name.jpg"),
                "mime_type": .string("image/jpeg"),
                "data_base64": .string(data.base64EncodedString()),
            ]),
            date: Date(timeIntervalSince1970: 0),
            directory: directory
        )

        XCTAssertTrue(result.path.hasPrefix(directory.path))
        XCTAssertTrue(result.filename.hasPrefix("19700101-"))
        XCTAssertFalse(result.filename.contains("/"))
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: result.path)), data)
    }

    func testProtocolMachineHandlesRelayOwnedBatteryWithoutCmuxDispatch() async {
        let cmux = RecordingCMUXFacade()
        let machine = WSProtocolMachine(cmux: cmux)
        _ = await machine.processText(#"{"deviceId":"d","appVersion":"1","protocolVersion":1}"#)

        let actions = await machine.processText(#"{"id":"b1","method":"host.battery","params":{}}"#)

        let calls = await cmux.snapshot()
        XCTAssertEqual(calls, [])
        XCTAssertEqual(actions.count, 1)
        guard case .sendText(let text) = actions[0] else { return XCTFail("expected sendText") }
        XCTAssertTrue(text.contains(#""id":"b1""#), text)
        XCTAssertTrue(text.contains(#""available""#), text)
    }

    func testProtocolMachineAnswersRelayInfoWithMessageAndUploadLimits() async {
        let cmux = RecordingCMUXFacade()
        let machine = WSProtocolMachine(cmux: cmux)
        _ = await machine.processText(#"{"deviceId":"d","appVersion":"1","protocolVersion":1}"#)

        let actions = await machine.processText(#"{"id":"i1","method":"relay.info","params":{}}"#)

        let calls = await cmux.snapshot()
        XCTAssertEqual(calls, [])
        guard actions.count == 1, case .sendText(let text) = actions[0] else { return XCTFail("expected sendText") }
        XCTAssertTrue(text.contains(#""id":"i1""#), text)
        XCTAssertTrue(text.contains(#""max_message_bytes":\#(HTTPServer.maxWebSocketFrameBytes)"#), text)
        XCTAssertTrue(text.contains(#""max_upload_bytes":\#(RelayFileUploadService.maxBytes)"#), text)
        XCTAssertTrue(text.contains(#""upload_chunk_bytes":\#(RelayFileUploadService.chunkBytes)"#), text)
    }

    private func chunk(_ id: String, _ offset: Int, _ text: String, done: Bool = false, filename: String = "notes.txt",
                       mimeType: String = "text/plain") -> JSONValue {
        .object([
            "upload_id": .string(id), "offset": .int(Int64(offset)), "data_base64": .string(Data(text.utf8).base64EncodedString()),
            "done": .bool(done), "filename": .string(filename), "mime_type": .string(mimeType),
        ])
    }

    private func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    }

    /// Any size: the file arrives in chunks that append to a hidden part file.
    func testChunkedUploadAppendsInOrderAndKeepsADocumentName() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let date = Date(timeIntervalSince1970: 0)
        XCTAssertEqual(try RelayFileUploadService.receive(params: chunk("upload-1234", 0, "hello "), date: date, directory: directory),
                       .object(["upload_id": .string("upload-1234"), "received": .int(6)]))
        _ = try RelayFileUploadService.receive(params: chunk("upload-1234", 6, "large "), date: date, directory: directory)
        let done = try RelayFileUploadService.receive(params: chunk("upload-1234", 12, "world", done: true, filename: "Makefile",
                                                                    mimeType: "application/octet-stream"),
                                                      date: date, directory: directory)
        guard case .object(let result) = done, case .string(let path)? = result["path"], case .string(let name)? = result["filename"] else {
            return XCTFail("expected an uploaded file")
        }
        XCTAssertEqual(name, "19700101-000000-Makefile", "a document is not renamed to .jpg")
        XCTAssertEqual(result["bytes"], .int(17))
        XCTAssertEqual(try String(contentsOfFile: path, encoding: .utf8), "hello large world")
        let left = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        XCTAssertEqual(left, [name], "the part file became the upload")

        let again = try RelayFileUploadService.receive(params: chunk("upload-5678", 0, "x", done: true, filename: "Makefile",
                                                                     mimeType: "application/octet-stream"),
                                                       date: date, directory: directory)
        guard case .object(let second) = again else { return XCTFail("expected an uploaded file") }
        XCTAssertEqual(second["filename"], .string("19700101-000000-Makefile-2"), "a second file in the same second keeps the first")
    }

    func testChunkAtTheWrongOffsetOrWithoutItsPartIsRefused() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        _ = try RelayFileUploadService.receive(params: chunk("upload-offset", 0, "abc"), directory: directory)
        XCTAssertThrowsError(try RelayFileUploadService.receive(params: chunk("upload-offset", 2, "x"), directory: directory)) {
            XCTAssertEqual($0 as? RelayFileUploadError, .offsetMismatch(received: 3))
        }
        XCTAssertThrowsError(try RelayFileUploadService.receive(params: chunk("upload-missing", 3, "x"), directory: directory)) {
            XCTAssertEqual($0 as? RelayFileUploadError, .interrupted)
        }
        XCTAssertThrowsError(try RelayFileUploadService.receive(params: chunk("../../etc", 0, "x"), directory: directory)) {
            XCTAssertEqual($0 as? RelayFileUploadError, .invalidParams)
        }
    }

    func testNewUploadClearsPartsAbandonedADayAgo() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let old = directory.appendingPathComponent(".panecast-upload-abandoned.part"), recent = directory.appendingPathComponent(".panecast-upload-inprogress.part")
        try Data("x".utf8).write(to: old)
        try Data("y".utf8).write(to: recent)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -25 * 3600)], ofItemAtPath: old.path)
        _ = try RelayFileUploadService.receive(params: chunk("upload-new-one", 0, "z"), directory: directory)
        let names = Set(try FileManager.default.contentsOfDirectory(atPath: directory.path))
        XCTAssertFalse(names.contains(old.lastPathComponent))
        XCTAssertTrue(names.contains(recent.lastPathComponent))
    }
}
