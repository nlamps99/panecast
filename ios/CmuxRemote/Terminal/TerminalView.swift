import SwiftUI
import UIKit
import SharedKit

struct TerminalView: View {
    static let bottomScrollPaddingRows: CGFloat = 5

    @Bindable var store: SurfaceStore
    var topContentInset: CGFloat = 0
    var bottomContentInset: CGFloat = 0
    var scrollToBottomRequest: Int = 0
    @AppStorage("cmux.terminalFontSize") private var preferredFontSize: Double = 15
    @AppStorage("cmux.terminalLineSpacing") private var preferredLineSpacing: Double = 2
    @AppStorage("cmux.terminalScanlines") private var scanlinesEnabled: Bool = true
    @AppStorage("cmux.terminalScanlineIntensity") private var scanlineIntensity: Double = 0.18
    // Read here purely so a theme switch invalidates this view and reaches
    // `TerminalHistoryCollectionView`, whose cells cache colors per palette.
    @AppStorage("cmux.theme") private var themeRaw: String = CmuxColorTheme.storm.rawValue
    @State private var pinchAnchorFontSize: CGFloat?

    private static let fontSizeRange: ClosedRange<CGFloat> = 8...32

    var body: some View {
        GeometryReader { proxy in
            let displayFontSize = Self.fontSizeRange.clamping(CGFloat(preferredFontSize))
            let lineHeight = displayFontSize + CGFloat(preferredLineSpacing)
            let bottomScrollPadding = Self.bottomScrollPadding(lineHeight: lineHeight)
            let topInset = max(0, topContentInset)
            let bottomInset = max(0, bottomContentInset)
            let viewportHeight = max(0, proxy.size.height - topInset - bottomInset)
            let contentWidth = proxy.size.width

            ZStack(alignment: .top) {
                CmuxTheme.terminal
                    .ignoresSafeArea()

                VStack(spacing: 0) {
                    Color.clear.frame(height: topInset)

                    TerminalHistoryCollectionView(
                        pages: store.historyPages,
                        liveRows: store.grid.rawRows,
                        width: contentWidth,
                        fontSize: displayFontSize,
                        lineHeight: lineHeight,
                        bottomPadding: bottomScrollPadding,
                        scrollToBottomRequest: scrollToBottomRequest,
                        isLoading: store.isLoadingOlderHistory,
                        onLoadOlder: { Task { await store.loadOlderHistory() } },
                        theme: themeRaw
                    )
                    .frame(width: contentWidth, height: viewportHeight)
                    .overlay {
                        if scanlinesEnabled {
                            TerminalScanlineOverlay(
                                lineHeight: lineHeight,
                                intensity: scanlineIntensity
                            )
                        }
                    }
                    .accessibilityIdentifier("TerminalViewport")
                    .accessibilityLabel(L10n.string("Terminal output"))
                    .accessibilityValue(accessibilitySnapshot)

                    Color.clear.frame(height: bottomInset)
                }
            }
            .simultaneousGesture(
                MagnifyGesture(minimumScaleDelta: 0.005)
                    .onChanged { value in
                        if pinchAnchorFontSize == nil { pinchAnchorFontSize = CGFloat(preferredFontSize) }
                        let base = pinchAnchorFontSize ?? CGFloat(preferredFontSize)
                        preferredFontSize = Double(Self.fontSizeRange.clamping(base * value.magnification))
                    }
                    .onEnded { value in
                        let base = pinchAnchorFontSize ?? CGFloat(preferredFontSize)
                        preferredFontSize = Double(Self.fontSizeRange.clamping(base * value.magnification))
                        pinchAnchorFontSize = nil
                    }
            )
        }
        .background(CmuxTheme.terminal)
    }

    static func bottomScrollPadding(lineHeight: CGFloat) -> CGFloat {
        lineHeight * bottomScrollPaddingRows
    }

    private var accessibilitySnapshot: String {
        store.grid.renderRows
            .prefix(6)
            .map { $0.plainText.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
    }
}

/// One virtual terminal viewport for both current output and scrollback.
/// History pages are inserted at index zero; the live terminal remains the
/// final item for the entire lifetime of this collection view. There is never
/// a Canvas-to-history-view mode switch, which is what previously made a
/// reader hit a boundary, wait, and then land in unrelated content.
private struct TerminalHistoryCollectionView: UIViewRepresentable {
    let pages: [TerminalHistoryPage]
    let liveRows: [String]
    let width: CGFloat
    let fontSize: CGFloat
    let lineHeight: CGFloat
    let bottomPadding: CGFloat
    let scrollToBottomRequest: Int
    let isLoading: Bool
    let onLoadOlder: () -> Void
    let theme: String

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> UICollectionView {
        let layout = UICollectionViewFlowLayout()
        layout.minimumLineSpacing = 0
        layout.minimumInteritemSpacing = 0
        layout.sectionInset = .zero
        layout.estimatedItemSize = .zero

        let collection = UICollectionView(frame: .zero, collectionViewLayout: layout)
        collection.backgroundColor = .clear
        collection.alwaysBounceVertical = true
        collection.showsVerticalScrollIndicator = false
        collection.keyboardDismissMode = .interactive
        collection.dataSource = context.coordinator
        collection.delegate = context.coordinator
        collection.register(TerminalHistoryTextCell.self, forCellWithReuseIdentifier: TerminalHistoryTextCell.reuseIdentifier)
        collection.accessibilityIdentifier = "TerminalHistoryViewport"
        context.coordinator.collectionView = collection
        return collection
    }

    func updateUIView(_ collection: UICollectionView, context: Context) {
        let items = pages.map { TerminalHistoryItem(id: $0.id, rows: $0.rows) }
            + [TerminalHistoryItem(id: SurfaceStore.liveHistoryAnchorID, rows: liveRows)]
        let coordinator = context.coordinator
        let previousItems = coordinator.items
        let previousIDs = previousItems.map(\.id)
        let itemIDs = items.map(\.id)
        let renderConfigChanged = coordinator.updateConfiguration(
            TerminalRenderConfiguration(
                width: width,
                fontSize: fontSize,
                lineHeight: lineHeight,
                theme: theme
            )
        )
        let itemsChanged = previousIDs != itemIDs
        let changedExistingIDs: Set<String> = Set(items.compactMap { item -> String? in
            guard let previous = previousItems.first(where: { $0.id == item.id }), previous.rows != item.rows else {
                return nil
            }
            return item.id
        })
        let shouldPinToBottom = coordinator.lastBottomRequest != scrollToBottomRequest

        coordinator.isLoading = isLoading
        coordinator.onLoadOlder = onLoadOlder
        coordinator.lastBottomRequest = scrollToBottomRequest
        coordinator.invalidateRenderCache(for: changedExistingIDs)
        collection.contentInset.bottom = bottomPadding
        collection.verticalScrollIndicatorInsets.bottom = bottomPadding

        guard itemsChanged || renderConfigChanged || !changedExistingIDs.isEmpty || shouldPinToBottom else { return }
        let prependedItems = !previousIDs.isEmpty
            && itemIDs.count > previousIDs.count
            && Array(itemIDs.suffix(previousIDs.count)) == previousIDs

        if previousIDs.isEmpty {
            coordinator.suppressTopRequestUntilInitialAnchor()
        }
        if prependedItems && !renderConfigChanged {
            let anchor = coordinator.captureViewportAnchor(in: collection)
            coordinator.items = items
            let inserted = (0..<(itemIDs.count - previousIDs.count)).map { IndexPath(item: $0, section: 0) }
            let reloaded = items.enumerated().compactMap { index, item in
                changedExistingIDs.contains(item.id) ? IndexPath(item: index, section: 0) : nil
            }
            collection.performBatchUpdates {
                collection.insertItems(at: inserted)
                if !reloaded.isEmpty { collection.reloadItems(at: reloaded) }
            } completion: { [weak coordinator, weak collection] _ in
                guard let coordinator, let collection else { return }
                collection.layoutIfNeeded()
                coordinator.restoreViewportAnchor(anchor, in: collection)
                if shouldPinToBottom { coordinator.pinToBottom(in: collection) }
            }
            return
        }

        coordinator.items = items
        let onlyLiveTailChanged = changedExistingIDs == Set([SurfaceStore.liveHistoryAnchorID])
        let liveTailKeptSameRowCount = previousItems.last?.rows.count == liveRows.count
        if !itemsChanged, !renderConfigChanged, onlyLiveTailChanged, liveTailKeptSameRowCount {
            // screen.diff changes only the current terminal grid. Reloading a
            // UICollectionView cell for every frame makes UIKit recycle and
            // fade the cell, which reads as a full-screen flash at the bottom
            // of the terminal. Keep the collection structure untouched and
            // replace the text in the already-visible live cell instead.
            coordinator.updateVisibleLiveTail(in: collection)
            if shouldPinToBottom {
                collection.layoutIfNeeded()
                coordinator.pinToBottom(in: collection)
            }
            return
        }
        if !itemsChanged, !renderConfigChanged, !changedExistingIDs.isEmpty {
            let visibleIDs = Set(collection.indexPathsForVisibleItems.compactMap { indexPath in
                indexPath.item < previousItems.count ? previousItems[indexPath.item].id : nil
            })
            let shouldRefreshLiveTail = shouldPinToBottom
                || coordinator.isAtBottom(in: collection)
                || changedExistingIDs.contains(SurfaceStore.liveHistoryAnchorID) && visibleIDs.contains(SurfaceStore.liveHistoryAnchorID)
            guard shouldRefreshLiveTail else { return }
            let reloads = items.enumerated().compactMap { index, item in
                changedExistingIDs.contains(item.id) ? IndexPath(item: index, section: 0) : nil
            }
            collection.performBatchUpdates {
                collection.reloadItems(at: reloads)
            } completion: { [weak coordinator, weak collection] _ in
                guard let coordinator, let collection, shouldPinToBottom || coordinator.isAtBottom(in: collection) else { return }
                collection.layoutIfNeeded()
                coordinator.pinToBottom(in: collection)
            }
            return
        }
        UIView.performWithoutAnimation {
            collection.reloadData()
            collection.collectionViewLayout.invalidateLayout()
            collection.layoutIfNeeded()
        }

        if previousIDs.isEmpty {
            coordinator.restoreInitialPosition(in: collection)
        } else if shouldPinToBottom {
            coordinator.pinToBottom(in: collection)
        }
    }

    final class Coordinator: NSObject, UICollectionViewDataSource, UICollectionViewDelegateFlowLayout {
        weak var collectionView: UICollectionView?
        var items: [TerminalHistoryItem] = []
        var isLoading = false
        var onLoadOlder: (() -> Void)?
        var lastBottomRequest = Int.min

        private var configuration: TerminalRenderConfiguration?
        private var viewportColumns: Int?
        private var heightCache: [String: CGFloat] = [:]
        private let attributedCache: NSCache<NSString, NSAttributedString> = {
            let cache = NSCache<NSString, NSAttributedString>()
            // Retain just enough parsed pages for the viewport and a short
            // fling. The complete source snapshot remains in the relay, not
            // in UIKit text objects on the iPad.
            cache.countLimit = 12
            return cache
        }()
        private var isTopRequestArmed = true
        private var suppressTopRequests = false

        struct ViewportAnchor {
            let id: String
            let offsetFromViewportTop: CGFloat
        }

        func updateConfiguration(_ next: TerminalRenderConfiguration) -> Bool {
            guard next.invalidatesCache(comparedTo: configuration) else { return false }
            configuration = next
            viewportColumns = TerminalHistoryTextRenderer.viewportColumns(
                fitting: next.width - TerminalHistoryTextCell.horizontalInsets,
                fontSize: next.fontSize
            )
            heightCache.removeAll(keepingCapacity: true)
            attributedCache.removeAllObjects()
            return true
        }

        func invalidateRenderCache(for ids: Set<String>) {
            for id in ids {
                attributedCache.removeObject(forKey: id as NSString)
                let prefix = "\(id)|"
                let staleHeightKeys = heightCache.keys.filter { $0.hasPrefix(prefix) }
                for key in staleHeightKeys {
                    heightCache.removeValue(forKey: key)
                }
            }
        }

        func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
            items.count
        }

        func collectionView(
            _ collectionView: UICollectionView,
            cellForItemAt indexPath: IndexPath
        ) -> UICollectionViewCell {
            guard let cell = collectionView.dequeueReusableCell(
                withReuseIdentifier: TerminalHistoryTextCell.reuseIdentifier,
                for: indexPath
            ) as? TerminalHistoryTextCell else {
                return UICollectionViewCell()
            }
            let item = items[indexPath.item]
            cell.apply(attributedText(for: item))
            return cell
        }

        func collectionView(
            _ collectionView: UICollectionView,
            layout collectionViewLayout: UICollectionViewLayout,
            sizeForItemAt indexPath: IndexPath
        ) -> CGSize {
            let width = max(1, collectionView.bounds.width)
            return CGSize(width: width, height: height(for: items[indexPath.item], width: width))
        }

        func updateVisibleLiveTail(in collection: UICollectionView) {
            guard let index = items.firstIndex(where: { $0.id == SurfaceStore.liveHistoryAnchorID }),
                  let cell = collection.cellForItem(at: IndexPath(item: index, section: 0)) as? TerminalHistoryTextCell
            else { return }
            cell.apply(attributedText(for: items[index]))
        }

        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            guard !suppressTopRequests else { return }
            // Fetch early enough that a normal fling never reaches a hard
            // edge while it waits for a broker round-trip.
            let threshold = max(240, scrollView.bounds.height * 3)
            if scrollView.contentOffset.y > threshold * 1.5 {
                isTopRequestArmed = true
            }
            guard scrollView.contentOffset.y <= threshold,
                  isTopRequestArmed,
                  !isLoading
            else { return }
            isTopRequestArmed = false
            onLoadOlder?()
        }

        func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
            suppressTopRequests = false
            isTopRequestArmed = true
        }

        func suppressTopRequestUntilInitialAnchor() {
            suppressTopRequests = true
            isTopRequestArmed = false
        }

        func restoreInitialPosition(in collection: UICollectionView) {
            let restore = { [weak self, weak collection] in
                guard let self, let collection else { return }
                collection.layoutIfNeeded()
                self.pinToBottom(in: collection)
                self.suppressTopRequests = false
                let threshold = max(240, collection.bounds.height * 3)
                self.isTopRequestArmed = collection.contentOffset.y > threshold * 1.5
            }
            // During the first UIViewRepresentable update, SwiftUI may not
            // have assigned the final viewport width yet. Running once on the
            // next main-loop pass gives the flow layout real dimensions.
            DispatchQueue.main.async(execute: restore)
        }

        func pinToBottom(in collection: UICollectionView) {
            let maxY = max(
                -collection.adjustedContentInset.top,
                collection.collectionViewLayout.collectionViewContentSize.height
                    - collection.bounds.height
                    + collection.adjustedContentInset.bottom
            )
            collection.setContentOffset(CGPoint(x: 0, y: maxY), animated: false)
        }

        func isAtBottom(in collection: UICollectionView) -> Bool {
            let maxY = max(
                -collection.adjustedContentInset.top,
                collection.collectionViewLayout.collectionViewContentSize.height
                    - collection.bounds.height
                    + collection.adjustedContentInset.bottom
            )
            return collection.contentOffset.y >= maxY - 24
        }

        func setContentOffset(_ proposedY: CGFloat, in collection: UICollectionView) {
            let minY = -collection.adjustedContentInset.top
            let maxY = max(
                minY,
                collection.collectionViewLayout.collectionViewContentSize.height
                    - collection.bounds.height
                    + collection.adjustedContentInset.bottom
            )
            collection.setContentOffset(CGPoint(x: 0, y: min(max(proposedY, minY), maxY)), animated: false)
        }

        func captureViewportAnchor(in collection: UICollectionView) -> ViewportAnchor? {
            let visible = collection.indexPathsForVisibleItems.sorted { lhs, rhs in
                let left = collection.layoutAttributesForItem(at: lhs)?.frame.minY ?? .greatestFiniteMagnitude
                let right = collection.layoutAttributesForItem(at: rhs)?.frame.minY ?? .greatestFiniteMagnitude
                return left < right
            }
            guard let indexPath = visible.first,
                  indexPath.item < items.count,
                  let attributes = collection.layoutAttributesForItem(at: indexPath)
            else { return nil }
            return ViewportAnchor(
                id: items[indexPath.item].id,
                offsetFromViewportTop: attributes.frame.minY - collection.contentOffset.y
            )
        }

        func restoreViewportAnchor(_ anchor: ViewportAnchor?, in collection: UICollectionView) {
            guard let anchor,
                  let index = items.firstIndex(where: { $0.id == anchor.id }),
                  let attributes = collection.layoutAttributesForItem(at: IndexPath(item: index, section: 0))
            else { return }
            setContentOffset(attributes.frame.minY - anchor.offsetFromViewportTop, in: collection)
            let threshold = max(240, collection.bounds.height * 3)
            if collection.contentOffset.y > threshold * 1.5 {
                isTopRequestArmed = true
            }
        }

        private func height(for item: TerminalHistoryItem, width: CGFloat) -> CGFloat {
            let key = "\(item.id)|\(Int(width.rounded()))"
            if let cached = heightCache[key] { return cached }
            let textWidth = max(1, width - TerminalHistoryTextCell.horizontalInsets)
            let measured = attributedText(for: item).boundingRect(
                with: CGSize(width: textWidth, height: .greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin, .usesFontLeading],
                context: nil
            ).height
            let height = max(configuration?.lineHeight ?? 0, ceil(measured)) + TerminalHistoryTextCell.verticalInsets
            heightCache[key] = height
            return height
        }

        private func attributedText(for item: TerminalHistoryItem) -> NSAttributedString {
            let key = item.id as NSString
            if let cached = attributedCache.object(forKey: key) { return cached }
            let result = TerminalHistoryTextRenderer.make(
                rows: item.rows,
                fontSize: configuration?.fontSize ?? CmuxFont.Role.headline.size,
                lineHeight: configuration?.lineHeight ?? 0,
                viewportColumns: viewportColumns
            )
            attributedCache.setObject(result, forKey: key)
            return result
        }
    }
}

/// Everything the UIKit terminal caches derived data against. `theme` matters
/// because `TerminalHistoryTextRenderer` bakes palette colors into the cached
/// `NSAttributedString`s, so a theme switch has to drop those caches or the
/// terminal keeps rendering the previous palette.
struct TerminalRenderConfiguration: Equatable {
    let width: CGFloat
    let fontSize: CGFloat
    let lineHeight: CGFloat
    let theme: String

    func invalidatesCache(comparedTo other: TerminalRenderConfiguration?) -> Bool {
        guard let other else { return true }
        return abs(width - other.width) > 0.5
            || abs(fontSize - other.fontSize) > 0.01
            || abs(lineHeight - other.lineHeight) > 0.01
            || theme != other.theme
    }
}

/// CRT scanlines drawn over the terminal viewport.
///
/// The shader-based `cmuxScanlines` layer effect cannot be used here: the
/// viewport is a `UIViewRepresentable` wrapping a `UICollectionView`, and
/// `layerEffect` on a live UIKit scroll view rasterises it every frame. This
/// overlay stays purely additive so scrolling keeps the UIKit fast path.
private struct TerminalScanlineOverlay: View {
    let lineHeight: CGFloat
    let intensity: Double

    var body: some View {
        GeometryReader { proxy in
            let band = max(2, lineHeight / 2)
            Canvas { context, size in
                var y: CGFloat = 0
                while y < size.height {
                    context.fill(
                        Path(CGRect(x: 0, y: y, width: size.width, height: band / 2)),
                        with: .color(.black.opacity(intensity))
                    )
                    y += band
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private struct TerminalHistoryItem: Identifiable {
    let id: String
    let rows: [String]
}

private final class TerminalHistoryTextCell: UICollectionViewCell {
    static let reuseIdentifier = "TerminalHistoryTextCell"
    static let horizontalInsets: CGFloat = 28
    static let verticalInsets: CGFloat = 16

    private let textView = UITextView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        contentView.backgroundColor = .clear
        textView.backgroundColor = .clear
        textView.isEditable = false
        textView.isSelectable = false
        textView.isScrollEnabled = false
        textView.isUserInteractionEnabled = false
        textView.textContainerInset = UIEdgeInsets(top: 8, left: 16, bottom: 8, right: 12)
        textView.textContainer.lineFragmentPadding = 0
        textView.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(textView)
        NSLayoutConstraint.activate([
            textView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            textView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            textView.topAnchor.constraint(equalTo: contentView.topAnchor),
            textView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        textView.attributedText = nil
    }

    func apply(_ text: NSAttributedString) {
        UIView.performWithoutAnimation {
            textView.attributedText = text
        }
    }
}

enum TerminalHistoryTextRenderer {
    /// `viewportColumns` is how many monospace cells fit on one visual line,
    /// or nil while the viewport width is still unknown.
    static func make(
        rows: [String],
        fontSize: CGFloat,
        lineHeight: CGFloat,
        viewportColumns: Int?
    ) -> NSAttributedString {
        let output = NSMutableAttributedString()
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = lineHeight
        paragraph.maximumLineHeight = lineHeight
        // Mac panes are far wider than a phone, so most rows wrap. Breaking at
        // word boundaries keeps English words whole; CJK still breaks between
        // characters, and an over-long path or URL still breaks mid-token.
        paragraph.lineBreakMode = .byWordWrapping

        for (rowIndex, rawRow) in rows.enumerated() {
            var cells = ANSIParser.parse(rawRow, base: .default)
            if let viewportColumns {
                cells = TerminalRuleRow.fit(cells, columns: viewportColumns)
            }
            var index = 0
            while index < cells.count {
                let attr = cells[index].attr
                var run = ""
                while index < cells.count, cells[index].attr == attr {
                    run += TerminalGlyph.textStyleString(for: cells[index].character)
                    index += 1
                }
                output.append(NSAttributedString(string: run, attributes: attributes(
                    for: attr,
                    fontSize: fontSize,
                    paragraph: paragraph
                )))
            }
            if rowIndex < rows.count - 1 {
                output.append(NSAttributedString(string: "\n", attributes: attributes(
                    for: .default,
                    fontSize: fontSize,
                    paragraph: paragraph
                )))
            }
        }

        // TextKit otherwise reports a zero-sized fragment for a completely
        // blank page, making a cell collapse and breaking offset compensation.
        if output.length == 0 {
            output.append(NSAttributedString(string: " ", attributes: attributes(
                for: .default,
                fontSize: fontSize,
                paragraph: paragraph
            )))
        }
        return output
    }

    private static func attributes(
        for attr: ANSIAttr,
        fontSize: CGFloat,
        paragraph: NSParagraphStyle
    ) -> [NSAttributedString.Key: Any] {
        [
            .font: font(named: attr.bold ? "GeistMono-Bold" : "GeistMono-Regular", size: fontSize, bold: attr.bold),
            .foregroundColor: attr.fg.uiKit,
            .backgroundColor: attr.bg == .default ? UIColor.clear : attr.bg.uiKit,
            .underlineStyle: attr.underline ? NSUnderlineStyle.single.rawValue : 0,
            .paragraphStyle: paragraph,
        ]
    }

    private static func font(named name: String, size: CGFloat, bold: Bool) -> UIFont {
        UIFont(name: name, size: size)
            ?? .monospacedSystemFont(ofSize: size, weight: bold ? .bold : .regular)
    }

    /// Monospace cells that fit in `textWidth`. One point of slack keeps
    /// floating-point rounding from wrapping the last glyph onto a new line.
    static func viewportColumns(fitting textWidth: CGFloat, fontSize: CGFloat) -> Int? {
        let regular = font(named: "GeistMono-Regular", size: fontSize, bold: false)
        let advance = ("──────────" as NSString).size(withAttributes: [.font: regular]).width / 10
        guard advance > 0, textWidth - 1 >= advance else { return nil }
        return Int(((textWidth - 1) / advance).rounded(.down))
    }
}

/// A row made only of horizontal-rule glyphs, such as Claude Code's prompt
/// separators or a `-----` banner. It is drawn for the Mac pane's width, so at
/// phone width it would wrap into several lines of dashes; trimming it to the
/// viewport keeps it one full-width rule. Rows with any other text are left
/// alone.
enum TerminalRuleRow {
    private static let ruleCharacters: Set<Character> = [
        "─", "━", "═", "╌", "╍", "┄", "┅", "┈", "┉", "-", "=",
    ]

    static func fit(_ cells: [ANSICell], columns: Int) -> [ANSICell] {
        guard cells.count > columns, isRule(cells) else { return cells }
        return Array(cells.prefix(max(1, columns)))
    }

    private static func isRule(_ cells: [ANSICell]) -> Bool {
        var sawRule = false
        for cell in cells where cell.character != " " {
            guard ruleCharacters.contains(cell.character) else { return false }
            sawRule = true
        }
        return sawRule
    }
}

private enum TerminalScrollTarget {
    static let bottom = "terminal-bottom"
    static let coordinateSpace = "terminal-scroll-coordinate-space"
}

private struct TerminalTopOffsetKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

private extension ClosedRange where Bound == CGFloat {
    func clamping(_ value: CGFloat) -> CGFloat {
        Swift.min(Swift.max(value, lowerBound), upperBound)
    }
}

/// iOS auto-promotes Unicode chars that have a default emoji presentation
/// (●, ✔, ☂, ⚠, ▶ …) to the system Apple Color Emoji font when our
/// monospace font lacks the glyph — which renders them as comically large
/// color emoji in the terminal grid. Variation Selector-15 (U+FE0E) tells
/// the renderer to keep the text-style glyph instead. We only append it
/// for scalars in the symbol/dingbat/geometric-shape ranges so ASCII and
/// CJK paths stay zero-overhead.
enum TerminalGlyph {
    static func textStyleString(for character: Character) -> String {
        if let substitute = substitutions[character] {
            return substitute
        }
        let s = String(character)
        guard let scalar = s.unicodeScalars.first, mayPromoteToEmoji(scalar) else {
            return s
        }
        return s + "\u{FE0E}"
    }

    /// Hard substitutions for chars Unicode flags as default-emoji-presentation
    /// where iOS has no text-style fallback glyph — VS-15 alone leaves them
    /// as full-color emoji. Map to a visually-equivalent text glyph plus
    /// VS-15 to keep the layout text-styled.
    private static let substitutions: [Character: String] = [
        "\u{23FA}": "\u{25CF}\u{FE0E}", // ⏺ Record → ●
        "\u{23F8}": "\u{2016}",          // ⏸ Pause → ‖
        "\u{23F9}": "\u{25A0}\u{FE0E}", // ⏹ Stop → ■
        "\u{23EB}": "\u{2191}",          // ⏫ Fast Up → ↑
        "\u{23EC}": "\u{2193}",          // ⏬ Fast Down → ↓
        "\u{23ED}": "\u{226B}",          // ⏭ Next → ≫
        "\u{23EE}": "\u{226A}",          // ⏮ Prev → ≪
        "\u{23EF}": "\u{25B6}\u{FE0E}", // ⏯ Play/Pause → ▶
    ]

    private static func mayPromoteToEmoji(_ scalar: Unicode.Scalar) -> Bool {
        let v = scalar.value
        // Geometric Shapes (●○■□▲▼…), Misc Symbols (☀☁☂…), Dingbats (✔✖✦…),
        // Misc Symbols & Pictographs lower band, plus the few stragglers that
        // iOS color-promotes from the BMP punctuation blocks.
        return (0x2190...0x21FF).contains(v) // Arrows
            || (0x2300...0x23FF).contains(v) // Misc Technical (⌘ ⏎ …)
            || (0x2460...0x24FF).contains(v) // Enclosed Alphanumerics
            || (0x25A0...0x25FF).contains(v) // Geometric Shapes
            || (0x2600...0x26FF).contains(v) // Misc Symbols
            || (0x2700...0x27BF).contains(v) // Dingbats
            || (0x2B00...0x2BFF).contains(v) // Misc Symbols and Arrows
            || (0x1F300...0x1F5FF).contains(v) // Misc Symbols & Pictographs
            || (0x1F600...0x1F64F).contains(v) // Emoticons
            || (0x1F680...0x1F6FF).contains(v) // Transport & Map
    }
}

private extension ANSIColor {
    // Tokyo Night Storm ANSI mapping — see github.com/folke/tokyonight.nvim.
    var swiftUI: Color {
        switch self {
        case .default: return CmuxTheme.terminalText
        case .red:     return CmuxTheme.accentRed
        case .green:   return CmuxTheme.accentGreen
        case .yellow:  return CmuxTheme.accentYellow
        case .blue:    return CmuxTheme.accentBlue
        case .magenta: return CmuxTheme.accentMagenta
        case .cyan:    return CmuxTheme.accentCyan
        case .white:   return CmuxTheme.terminalText
        case .black:   return CmuxTheme.mutedDim
        case .indexed(let value): return Self.indexedColor(value)
        case .rgb(let red, let green, let blue):
            return Color(
                red: Double(red) / 255.0,
                green: Double(green) / 255.0,
                blue: Double(blue) / 255.0
            )
        case .bright(let inner): return inner.swiftUI
        }
    }

    var uiKit: UIColor {
        UIColor(swiftUI)
    }

    static func indexedColor(_ value: Int) -> Color {
        let clamped = max(0, min(255, value))
        let system: [Color] = [
            CmuxTheme.mutedDim,
            CmuxTheme.accentRed,
            CmuxTheme.accentGreen,
            CmuxTheme.accentYellow,
            CmuxTheme.accentBlue,
            CmuxTheme.accentMagenta,
            CmuxTheme.accentCyan,
            CmuxTheme.terminalText,
            CmuxTheme.muted,
            CmuxTheme.accentRed.opacity(1.0),
            CmuxTheme.accentGreen.opacity(1.0),
            CmuxTheme.accentYellow.opacity(1.0),
            CmuxTheme.accentBlue.opacity(1.0),
            CmuxTheme.accentMagenta.opacity(1.0),
            CmuxTheme.accentCyan.opacity(1.0),
            Color.white,
        ]
        if clamped < system.count { return system[clamped] }
        if clamped >= 232 {
            let shade = Double(8 + (clamped - 232) * 10) / 255.0
            return Color(red: shade, green: shade, blue: shade)
        }
        let cubeIndex = clamped - 16
        let levels = [0, 95, 135, 175, 215, 255]
        let red = levels[(cubeIndex / 36) % 6]
        let green = levels[(cubeIndex / 6) % 6]
        let blue = levels[cubeIndex % 6]
        return Color(
            red: Double(red) / 255.0,
            green: Double(green) / 255.0,
            blue: Double(blue) / 255.0
        )
    }
}
