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
}
