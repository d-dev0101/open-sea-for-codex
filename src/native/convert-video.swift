// Local-only video normalization. Built at package time; end users do not need Swift.
// CLI: open-sea-convert-video --input /absolute/source.mov --output /absolute/result.mp4
// Exit codes: 64 arguments, 65 media, 66 input, 73 output, 74 export, 130/143 cancellation.
import AVFoundation
import Darwin
import Foundation

private struct ConversionError: Error {
    let code: Int32
    let message: String
}

private final class VideoConverter {
    private let files = FileManager.default
    private var workDirectory: URL?
    private var exporter: AVAssetExportSession?
    private var signals: [DispatchSourceSignal] = []
    private var progressTimer: DispatchSourceTimer?
    private var cancellation: Int32?
    private var finished = false
    private var lastProgress = -1
    private let cancellationLock = NSLock()
    private var preprocessingCancelled = false
    private var originalTrackForFallback: AVAssetTrack?
    private var sourceAsset: AVAsset?
    private var optimizedAsset: AVAsset?

    private func diagnostic(_ message: String) {
        FileHandle.standardError.write(Data(("open-sea-video: " + message + "\n").utf8))
    }

    private func finish(_ code: Int32, _ message: String? = nil) -> Never {
        finished = true
        progressTimer?.cancel()
        if let directory = workDirectory { try? files.removeItem(at: directory) }
        if let message = message { diagnostic(message) }
        exit(code)
    }

    private func fail(_ error: Error, defaultCode: Int32 = 74) -> Never {
        if let error = error as? ConversionError { finish(error.code, error.message) }
        let underlying = error as NSError
        // Stable prefix/code for callers; OS detail is useful for diagnostics only.
        finish(defaultCode, "conversion failed (\(underlying.domain) \(underlying.code)): \(underlying.localizedDescription)")
    }

    private func exists(_ url: URL) -> Bool {
        var info = stat()
        return url.path.withCString { lstat($0, &info) } == 0
    }

    private func paths() throws -> (URL, URL) {
        let args = Array(CommandLine.arguments.dropFirst())
        guard args.count == 4, args[0] == "--input", args[2] == "--output",
              args[1].hasPrefix("/"), args[3].hasPrefix("/"),
              !args[1].contains("\0"), !args[3].contains("\0") else {
            throw ConversionError(code: 64, message: "usage: open-sea-convert-video --input /absolute/source --output /absolute/result.mp4")
        }
        let input = URL(fileURLWithPath: args[1]).standardizedFileURL.resolvingSymlinksInPath()
        let output = URL(fileURLWithPath: args[3]).standardizedFileURL
        guard output.pathExtension.lowercased() == "mp4" else {
            throw ConversionError(code: 64, message: "output must have an .mp4 extension")
        }
        guard let attributes = try? files.attributesOfItem(atPath: input.path),
              attributes[.type] as? FileAttributeType == .typeRegular,
              files.isReadableFile(atPath: input.path) else {
            throw ConversionError(code: 66, message: "input must be a readable local regular file")
        }
        guard !exists(output) else {
            throw ConversionError(code: 73, message: "output already exists; refusing to replace it")
        }
        let parent = output.deletingLastPathComponent().resolvingSymlinksInPath()
        guard let attributes = try? files.attributesOfItem(atPath: parent.path),
              attributes[.type] as? FileAttributeType == .typeDirectory,
              files.isWritableFile(atPath: parent.path) else {
            throw ConversionError(code: 73, message: "output parent must be an existing writable directory")
        }
        return (input, parent.appendingPathComponent(output.lastPathComponent))
    }

    private func handleSignals() {
        for number in [SIGINT, SIGTERM] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [self] in
                guard !finished, cancellation == nil else { return }
                cancellation = 128 + number
                cancellationLock.lock()
                preprocessingCancelled = true
                cancellationLock.unlock()
                exporter?.cancelExport()
                // The parent may also force-kill and remove <output>.open-sea-work.
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [self] in
                    if !finished { finish(128 + number, "conversion cancelled") }
                }
            }
            source.resume()
            signals.append(source)
        }
    }

    func run() {
        do {
            let (input, output) = try paths()
            handleSignals()
            let asset = AVURLAsset(url: input, options: [
                AVURLAssetPreferPreciseDurationAndTimingKey: true,
                AVURLAssetReferenceRestrictionsKey: AVAssetReferenceRestrictions.forbidAll.rawValue
            ])
            sourceAsset = asset
            asset.loadValuesAsynchronously(forKeys: ["tracks", "duration"]) { [self] in
                DispatchQueue.main.async { [self] in
                    do {
                        var loadingError: NSError?
                        guard asset.statusOfValue(forKey: "tracks", error: &loadingError) == .loaded,
                              asset.statusOfValue(forKey: "duration", error: &loadingError) == .loaded,
                              let track = asset.tracks(withMediaType: .video).first else {
                            throw ConversionError(code: 65, message: "input has no readable video track")
                        }
                        track.loadValuesAsynchronously(forKeys: ["naturalSize", "preferredTransform", "timeRange", "nominalFrameRate", "formatDescriptions"]) { [self] in
                            DispatchQueue.main.async { [self] in
                                do { try startConversion(track: track, output: output) }
                                catch { fail(error) }
                            }
                        }
                    } catch { fail(error) }
                }
            }
        } catch { fail(error) }
    }

    private func isPreprocessingCancelled() -> Bool {
        cancellationLock.lock()
        defer { cancellationLock.unlock() }
        return preprocessingCancelled
    }

    private func makeWorkDirectory(output: URL) throws -> URL {
        if let directory = workDirectory { return directory }
        let directory = URL(fileURLWithPath: output.path + ".open-sea-work", isDirectory: true)
        guard mkdir(directory.path, 0o700) == 0 else {
            throw ConversionError(code: 73, message: "could not exclusively create output work directory")
        }
        workDirectory = directory
        return directory
    }

    private func startConversion(track: AVAssetTrack, output: URL) throws {
        let directory = try makeWorkDirectory(output: output)
        // Apple's aerials can contain 240 fps HEVC. Decode only the temporal layers
        // needed for 30 fps when the entire track explicitly proves that safe.
        // Ordinary media and unrecognized encodings keep the established exporter.
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            let reduced = try? reduceTemporalLayers(track: track, directory: directory)
            DispatchQueue.main.async { [self] in
                if let code = cancellation { finish(code, "conversion cancelled") }
                optimizedAsset = reduced
                let candidate = reduced?.tracks(withMediaType: .video).first
                do {
                    if candidate != nil { originalTrackForFallback = track }
                    try startExport(track: candidate ?? track, output: output)
                } catch {
                    if candidate != nil {
                        diagnostic("temporal metadata unavailable; using full decode")
                        originalTrackForFallback = nil
                        do { try startExport(track: track, output: output) }
                        catch { fail(error) }
                    } else { fail(error) }
                }
            }
        }
    }

    private func temporalLevel(_ sample: CMSampleBuffer) -> Int? {
        guard CMSampleBufferGetNumSamples(sample) == 1,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[String: Any]],
              let info = attachments.first?[kCMSampleAttachmentKey_HEVCTemporalLevelInfo as String] as? [String: Any],
              let level = info[kCMHEVCTemporalLevelInfoKey_TemporalLevel as String] as? Int,
              (0...7).contains(level) else { return nil }
        return level
    }

    private func reduceTemporalLayers(track: AVAssetTrack, directory: URL) throws -> AVAsset? {
        guard track.nominalFrameRate >= 90, track.timeRange.start == .zero,
              track.timeRange.duration.seconds.isFinite, track.timeRange.duration.seconds > 0,
              let asset = track.asset,
              let description = track.formatDescriptions.first else { return nil }
        let format = description as! CMFormatDescription
        guard CMFormatDescriptionGetMediaSubType(format) == kCMVideoCodecType_HEVC else { return nil }
        let duration = track.timeRange.duration.seconds
        let reader = try AVAssetReader(asset: asset)
        let source = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        source.alwaysCopiesSampleData = false
        guard reader.canAdd(source) else { return nil }
        reader.add(source)
        guard reader.startReading() else { return nil }
        defer { if reader.status == .reading { reader.cancelReading() } }
        var frames: [(time: Double, level: Int)] = []
        while let sample = source.copyNextSampleBuffer() {
            if isPreprocessingCancelled() { return nil }
            if CMSampleBufferGetNumSamples(sample) == 0 { continue }
            let time = CMSampleBufferGetPresentationTimeStamp(sample).seconds
            guard frames.count < 2_000_000, let level = temporalLevel(sample),
                  time.isFinite, time >= 0, time < duration else { return nil }
            frames.append((time, level))
        }
        guard reader.status == .completed, !frames.isEmpty else { return nil }
        // The complete scan is necessary: never assume every HEVC file has Apple's
        // hierarchy. A retained layer must cover the full timeline at ~30 fps,
        // without missing sections, duplicate timestamps, or a shortened ending.
        frames.sort { $0.time < $1.time }
        var selectedLevel: Int?
        for level in 0...7 {
            let times = frames.filter { $0.level <= level }.map { $0.time }
            guard times.count < frames.count, Double(times.count) / duration >= 29,
                  Double(times.count) / duration <= 30.1,
                  let first = times.first, first <= 0.001,
                  let last = times.last, duration - last <= 1.0 / 29 else { continue }
            let regular = zip(times, times.dropFirst()).allSatisfy {
                let step = $1 - $0
                return step >= 1.0 / 30.1 && step <= 1.0 / 29
            }
            if regular { selectedLevel = level; break }
        }
        guard let level = selectedLevel, !isPreprocessingCancelled() else { return nil }
        let compressed = try AVAssetReader(asset: asset)
        let compressedOutput = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        compressedOutput.alwaysCopiesSampleData = false
        guard compressed.canAdd(compressedOutput) else { return nil }
        compressed.add(compressedOutput)
        let reducedURL = directory.appendingPathComponent("temporal.mov")
        let writer = try AVAssetWriter(outputURL: reducedURL, fileType: .mov)
        // nil outputSettings remuxes compressed samples. HEVC temporal-level
        // semantics guarantee lower layers do not reference discarded higher ones.
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: nil, sourceFormatHint: format)
        input.expectsMediaDataInRealTime = false
        input.transform = track.preferredTransform
        guard writer.canAdd(input) else { return nil }
        writer.add(input)
        defer {
            if compressed.status == .reading { compressed.cancelReading() }
            if writer.status == .writing { writer.cancelWriting() }
        }
        guard writer.startWriting(), compressed.startReading() else { return nil }
        writer.startSession(atSourceTime: .zero)
        var kept = 0
        while let sample = compressedOutput.copyNextSampleBuffer() {
            if isPreprocessingCancelled() { return nil }
            if CMSampleBufferGetNumSamples(sample) == 0 { continue }
            guard let sampleLevel = temporalLevel(sample) else { return nil }
            if sampleLevel > level { continue }
            let deadline = Date().addingTimeInterval(30)
            while !input.isReadyForMoreMediaData {
                if isPreprocessingCancelled() || writer.status != .writing || Date() >= deadline { return nil }
                Thread.sleep(forTimeInterval: 0.002)
            }
            guard input.append(sample) else { return nil }
            kept += 1
        }
        guard compressed.status == .completed,
              kept == frames.filter({ $0.level <= level }).count else { return nil }
        input.markAsFinished()
        writer.endSession(atSourceTime: track.timeRange.duration)
        let complete = DispatchSemaphore(value: 0)
        writer.finishWriting { complete.signal() }
        while complete.wait(timeout: .now() + 0.1) == .timedOut {
            if isPreprocessingCancelled() { writer.cancelWriting(); return nil }
        }
        guard writer.status == .completed else { return nil }
        let reduced = AVURLAsset(url: reducedURL, options: [AVURLAssetReferenceRestrictionsKey: AVAssetReferenceRestrictions.forbidAll.rawValue])
        guard let result = reduced.tracks(withMediaType: .video).first,
              abs(result.timeRange.duration.seconds - duration) <= 0.001,
              result.naturalSize == track.naturalSize,
              result.preferredTransform == track.preferredTransform else { return nil }
        diagnostic("temporal optimization retained \(kept) of \(frames.count) frames")
        return reduced
    }

    private func startExport(track: AVAssetTrack, output: URL) throws {
        for key in ["naturalSize", "preferredTransform", "timeRange"] {
            var loadingError: NSError?
            guard track.statusOfValue(forKey: key, error: &loadingError) == .loaded else {
                throw ConversionError(code: 65, message: "video geometry or timing could not be read")
            }
        }
        let range = track.timeRange
        guard range.duration.seconds.isFinite, range.duration.seconds > 0 else {
            throw ConversionError(code: 65, message: "video duration is invalid")
        }
        let bounds = CGRect(origin: .zero, size: track.naturalSize).applying(track.preferredTransform).standardized
        guard bounds.width.isFinite, bounds.height.isFinite, bounds.width >= 2, bounds.height >= 2 else {
            throw ConversionError(code: 65, message: "video dimensions are invalid")
        }
        let scale = min(1, 1920 / bounds.width, 1080 / bounds.height)
        let width = max(2, floor(bounds.width * scale / 2) * 2)
        let height = max(2, floor(bounds.height * scale / 2) * 2)
        // A video-only composition avoids retaining audio or unrelated source tracks.
        let composition = AVMutableComposition()
        guard let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw ConversionError(code: 65, message: "video composition could not be created")
        }
        try videoTrack.insertTimeRange(range, of: track, at: .zero)
        let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: videoTrack)
        let transform = track.preferredTransform
            .concatenating(CGAffineTransform(translationX: -bounds.minX, y: -bounds.minY))
            .concatenating(CGAffineTransform(scaleX: width / bounds.width, y: height / bounds.height))
        layer.setTransform(transform, at: .zero)
        let instruction = AVMutableVideoCompositionInstruction()
        instruction.timeRange = CMTimeRange(start: .zero, duration: composition.duration)
        instruction.layerInstructions = [layer]
        let video = AVMutableVideoComposition()
        video.renderSize = CGSize(width: width, height: height)
        video.frameDuration = CMTime(value: 1, timescale: 30)
        video.sourceTrackIDForFrameTiming = kCMPersistentTrackID_Invalid
        video.instructions = [instruction]

        // Apple's H.264 preset also converts HDR input into SDR for browser playback.
        guard let session = AVAssetExportSession(asset: composition, presetName: AVAssetExportPreset1920x1080),
              session.supportedFileTypes.contains(.mp4) else {
            throw ConversionError(code: 65, message: "H.264 MP4 export is unavailable for this video")
        }
        let directory = try makeWorkDirectory(output: output)
        let temporary = directory.appendingPathComponent("video.mp4")
        session.outputURL = temporary
        session.outputFileType = .mp4
        session.shouldOptimizeForNetworkUse = true
        session.videoComposition = video
        exporter = session
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: 1)
        timer.setEventHandler { [self] in
            let percent = Int(session.progress * 100)
            if percent != lastProgress {
                lastProgress = percent
                FileHandle.standardOutput.write(Data(("{\"progress\":\(percent)}\n").utf8))
            }
        }
        progressTimer = timer
        timer.resume()
        session.exportAsynchronously { [self] in
            DispatchQueue.main.async { [self] in
                if let code = cancellation { finish(code, "conversion cancelled") }
                guard session.status == .completed else {
                    if let original = originalTrackForFallback {
                        diagnostic("temporal export unavailable; using full decode")
                        originalTrackForFallback = nil
                        progressTimer?.cancel()
                        try? files.removeItem(at: temporary)
                        do { try startExport(track: original, output: output); return }
                        catch { fail(error) }
                    }
                    if let error = session.error { fail(error) }
                    finish(74, "video export did not complete")
                }
                // link() publishes on the same filesystem atomically and never replaces
                // an existing file, including a destination created during the export.
                guard link(temporary.path, output.path) == 0 else {
                    finish(73, "could not publish output without replacing an existing file (errno \(errno))")
                }
                FileHandle.standardOutput.write(Data("{\"progress\":100,\"complete\":true}\n".utf8))
                finish(0)
            }
        }
    }
}

private let converter = VideoConverter()
converter.run()
dispatchMain()
