package com.genie.cmuxremote.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Backspace
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.filled.Apps
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardHide
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.genie.cmuxremote.state.AppViewModel
import com.genie.cmuxremote.state.InputStatus
import com.genie.cmuxremote.state.Surface
import com.genie.cmuxremote.term.AnsiParser
import kotlinx.coroutines.launch

/**
 * Android port of iOS `WorkspaceView` (the "Active" tab): terminal canvas
 * behind a header pill + surface chips, floating accessory panel with the
 * CMD/LIVE input and the shortcut key rows.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TerminalScreen(
    vm: AppViewModel,
    onBack: () -> Unit,
) {
    val workspace = vm.workspaces.firstOrNull { it.id == vm.selectedWorkspaceId }
    val surfaces = workspace?.let { vm.surfacesFor(it.id) } ?: emptyList()
    var showDrawer by remember { mutableStateOf(false) }
    var pendingCloseSurface by remember { mutableStateOf<Surface?>(null) }
    var input by remember { mutableStateOf("") }
    var liveEcho by remember { mutableStateOf("") }
    val keyboard = LocalSoftwareKeyboardController.current
    val clipboard = LocalClipboardManager.current
    val imeVisible = WindowInsets.ime.getBottom(LocalDensity.current) > 0

    // Open the preferred surface (inbox jump), else the first surface.
    LaunchedEffect(workspace?.id, surfaces.map { it.id }, vm.preferredSurfaceId) {
        val ws = workspace ?: return@LaunchedEffect
        val preferred = vm.preferredSurfaceId
        if (preferred != null && surfaces.any { it.id == preferred }) {
            vm.preferredSurfaceId = null
            if (vm.subscribedSurfaceId != preferred) vm.openSurface(ws.id, preferred)
        } else if (preferred != null && surfaces.isNotEmpty()) {
            vm.preferredSurfaceId = null
        }
        if (vm.subscribedWorkspaceId != ws.id || vm.subscribedSurfaceId == null) {
            surfaces.firstOrNull()?.let { vm.openSurface(ws.id, it.id) }
        }
    }

    LaunchedEffect(Unit) { vm.refreshBattery() }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(CmuxTerminal),
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            // ---- header -------------------------------------------------
            Column(
                modifier = Modifier
                    .statusBarsPadding()
                    .padding(horizontal = 18.dp)
                    .padding(top = 12.dp),
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    SquareIconButton(
                        icon = Icons.AutoMirrored.Filled.KeyboardArrowLeft,
                        desc = "Back",
                    ) { onBack() }

                    // workspace pill
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .weight(1f)
                            .height(40.dp)
                            .cmuxSurface(corner = 6.dp, fill = CmuxSurfaceSunken)
                            .padding(horizontal = 12.dp),
                    ) {
                        Text("●", style = cmuxDisplay(11f), color = CmuxAccentGreen)
                        Spacer(Modifier.width(8.dp))
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                vm.computerName,
                                style = cmuxMono(9f),
                                color = CmuxInkDim,
                                maxLines = 1,
                            )
                            Text(
                                workspace?.name ?: "no workspace",
                                style = cmuxMono(13f, FontWeight.Medium),
                                color = CmuxInk,
                                maxLines = 1,
                            )
                        }
                        BatteryBadge(vm)
                        Spacer(Modifier.width(6.dp))
                        Text(
                            "×",
                            style = cmuxDisplay(16f),
                            color = CmuxMuted,
                            modifier = Modifier
                                .clickable(onClick = onBack)
                                .padding(horizontal = 4.dp),
                        )
                    }

                    SquareIconButton(icon = Icons.Filled.Apps, desc = "Surfaces") {
                        showDrawer = true
                    }
                }

                // surface chips — hidden while the keyboard is up, like iOS
                if (!imeVisible && workspace != null) {
                    Spacer(Modifier.height(10.dp))
                    Row(
                        modifier = Modifier.horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        surfaces.forEach { s ->
                            SurfaceChip(
                                title = s.title,
                                isSelected = vm.subscribedSurfaceId == s.id,
                                canClose = surfaces.size > 1,
                                onSelect = { workspace.let { vm.openSurface(it.id, s.id) } },
                                onClose = { pendingCloseSurface = s },
                            )
                        }
                        NewSurfaceChip { workspace.let { vm.createSurface(it.id) } }
                    }
                }
            }

            // ---- terminal canvas -----------------------------------------
            Box(modifier = Modifier.weight(1f)) {
                TerminalCanvas(vm = vm, modifier = Modifier.fillMaxSize())
            }

            // ---- accessory panel -----------------------------------------
            AccessoryPanel(
                vm = vm,
                input = input,
                onInputChange = { new ->
                    if (vm.liveInputMode) {
                        liveDiffSend(old = input, new = new, vm = vm)
                        liveEcho = (liveEcho + new.drop(commonPrefixLen(input, new)))
                            .replace(" ", "␠").takeLast(48)
                    }
                    input = new
                },
                imeVisible = imeVisible,
                onDismissKeyboard = { keyboard?.hide() },
                onBackspace = { vm.sendKey("backspace") },
                onPaste = {
                    clipboard.getText()?.text?.let { input += it }
                },
                onSubmit = {
                    if (vm.liveInputMode) {
                        vm.sendKey("enter")
                        liveEcho = ""
                    } else {
                        vm.submitCommand(input)
                    }
                    input = ""
                    if (!vm.keepKeyboardAfterSubmit) keyboard?.hide()
                },
            )
        }

        pendingCloseSurface?.let { surface ->
            AlertDialog(
                onDismissRequest = { pendingCloseSurface = null },
                containerColor = CmuxSurface,
                title = {
                    Text("Close surface?", style = cmuxMono(15f, FontWeight.Bold), color = CmuxInk)
                },
                text = {
                    Text(
                        "Close ${surface.title}? This closes the terminal surface in cmux.",
                        style = cmuxMono(12f),
                        color = CmuxInkDim,
                    )
                },
                confirmButton = {
                    TextButton(onClick = {
                        workspace?.let { vm.closeSurface(it.id, surface.id) }
                        pendingCloseSurface = null
                    }) { Text("Close ${surface.title}", color = CmuxAccentRed, style = cmuxDisplay(11f)) }
                },
                dismissButton = {
                    TextButton(onClick = { pendingCloseSurface = null }) {
                        Text("Cancel", color = CmuxMuted, style = cmuxDisplay(11f))
                    }
                },
            )
        }

        if (showDrawer) {
            ModalBottomSheet(
                onDismissRequest = { showDrawer = false },
                containerColor = CmuxCanvas,
            ) {
                WorkspaceDrawer(vm = vm) { workspaceId, surfaceId ->
                    vm.selectWorkspace(workspaceId)
                    vm.markWorkspaceSeen(workspaceId)
                    vm.openSurface(workspaceId, surfaceId)
                    showDrawer = false
                }
            }
        }
    }
}

private fun commonPrefixLen(a: String, b: String): Int {
    var i = 0
    while (i < a.length && i < b.length && a[i] == b[i]) i++
    return i
}

// ---------------------------------------------------------------------
// Accessory panel — input mode toggle, $ field, key rows (iOS terminalAccessory)
// ---------------------------------------------------------------------

@Composable
private fun AccessoryPanel(
    vm: AppViewModel,
    input: String,
    onInputChange: (String) -> Unit,
    imeVisible: Boolean,
    onDismissKeyboard: () -> Unit,
    onBackspace: () -> Unit,
    onPaste: () -> Unit,
    onSubmit: () -> Unit,
) {
    Column(
        modifier = Modifier
            .imePadding()
            .navigationBarsPadding()
            .padding(horizontal = 16.dp)
            .padding(bottom = 10.dp)
            .shadow(20.dp, RoundedCornerShape(10.dp))
            .cmuxSurface(corner = 10.dp, fill = CmuxSurface)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // input row: [CMD|LIVE] $ field
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .cmuxSurface(corner = 6.dp, fill = CmuxSurfaceSunken)
                .padding(horizontal = 12.dp, vertical = 10.dp),
        ) {
            // CMD / LIVE toggle
            Box(
                modifier = Modifier
                    .width(42.dp)
                    .height(26.dp)
                    .clip(RoundedCornerShape(5.dp))
                    .background(if (vm.liveInputMode) CmuxAccentGreen else CmuxSurface)
                    .cmuxHairline(corner = 5.dp)
                    .clickable {
                        vm.liveInputMode = !vm.liveInputMode
                        onInputChange("")
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    if (vm.liveInputMode) "LIVE" else "CMD",
                    style = cmuxDisplay(10f),
                    color = if (vm.liveInputMode) CmuxCanvas else CmuxAccentGreen,
                )
            }
            Spacer(Modifier.width(8.dp))
            Text("$", style = cmuxDisplay(14f), color = CmuxAccentGreen)
            Spacer(Modifier.width(8.dp))
            BasicTextField(
                value = input,
                onValueChange = onInputChange,
                textStyle = cmuxMono(14f).copy(color = CmuxInk),
                cursorBrush = SolidColor(CmuxAccentGreen),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { onSubmit() }),
                modifier = Modifier.weight(1f),
                decorationBox = { inner ->
                    Box {
                        if (input.isEmpty()) {
                            Text(
                                if (vm.liveInputMode) "Type to send immediately…" else "type a command…",
                                style = cmuxMono(14f),
                                color = CmuxMuted,
                                maxLines = 1,
                            )
                        }
                        inner()
                    }
                },
            )
        }

        // control row: dismiss / backspace / paste / [ ENTER ]
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            PanelIconKey(Icons.Filled.KeyboardHide, "Dismiss keyboard", onDismissKeyboard)
            PanelIconKey(Icons.AutoMirrored.Filled.Backspace, "Backspace", onBackspace)
            PanelIconKey(Icons.Filled.ContentPaste, "Paste", onPaste)
            Spacer(Modifier.weight(1f))
            Box(
                modifier = Modifier
                    .height(36.dp)
                    .clip(RoundedCornerShape(6.dp))
                    .background(CmuxAccentGreen)
                    .clickable(onClick = onSubmit)
                    .padding(horizontal = 14.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text("[ ENTER ]", style = cmuxDisplay(12f), color = CmuxCanvas)
            }
        }

        // input feedback
        when (val status = vm.inputStatus) {
            is InputStatus.Sending -> FeedbackLine("›", "Sending…", CmuxAccentGreen)
            is InputStatus.Sent -> FeedbackLine("›", status.message, CmuxAccentGreen)
            is InputStatus.Failed -> FeedbackLine("!", status.message, CmuxAccentRed)
            is InputStatus.Idle -> Unit
        }

        // shortcut rows — iOS KeyButton rows
        if (vm.showShortcutBar) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    KeyButton("esc", Modifier.weight(1f)) { vm.sendKey("escape") }
                    KeyButton("^C", Modifier.weight(1f)) { vm.sendKey("ctrl-c") }
                    KeyButton("tab", Modifier.weight(1f)) { vm.sendKey("tab") }
                    KeyButton("←", Modifier.weight(1f)) { vm.sendKey("left") }
                    KeyButton("↑", Modifier.weight(1f)) { vm.sendKey("up") }
                    KeyButton("↓", Modifier.weight(1f)) { vm.sendKey("down") }
                    KeyButton("→", Modifier.weight(1f)) { vm.sendKey("right") }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    KeyButton("OK", Modifier.weight(1f)) {
                        vm.sendText("OK")
                        vm.sendKey("enter")
                    }
                    KeyButton("/", Modifier.weight(1f)) { vm.sendText("/") }
                    KeyButton("$", Modifier.weight(1f)) { vm.sendText("$") }
                    KeyButton("/new", Modifier.weight(1f)) { vm.sendText("/new") }
                    KeyButton("space", Modifier.weight(1f)) { vm.sendText(" ") }
                }
            }
        }
    }
}

@Composable
private fun FeedbackLine(mark: String, message: String, color: Color) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(mark, style = cmuxDisplay(11f), color = color)
        Spacer(Modifier.width(6.dp))
        Text(message, style = cmuxMono(11f), color = color, maxLines = 2)
    }
}

@Composable
private fun PanelIconKey(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    desc: String,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(36.dp)
            .cmuxSurface(corner = 6.dp, fill = CmuxSurfaceSunken)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = desc, tint = CmuxInkDim, modifier = Modifier.size(15.dp))
    }
}

@Composable
private fun KeyButton(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Box(
        modifier = modifier
            .height(34.dp)
            .cmuxSurface(corner = 5.dp, fill = CmuxSurfaceSunken)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = cmuxDisplay(11f), color = CmuxInk)
    }
}

// ---------------------------------------------------------------------
// Surface chips — iOS SurfaceChip / NewSurfaceChip
// ---------------------------------------------------------------------

@Composable
private fun SurfaceChip(
    title: String,
    isSelected: Boolean,
    canClose: Boolean,
    onSelect: () -> Unit,
    onClose: () -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .height(28.dp)
            .cmuxSurface(
                corner = 4.dp,
                fill = if (isSelected) CmuxSurfaceRaised else CmuxSurfaceSunken,
                border = if (isSelected) CmuxAccentGreen else CmuxDivider,
            ),
    ) {
        Text(
            title,
            style = cmuxMono(11f, if (isSelected) FontWeight.Medium else FontWeight.Normal),
            color = if (isSelected) CmuxAccentGreen else CmuxMuted,
            maxLines = 1,
            modifier = Modifier
                .clickable(onClick = onSelect)
                .padding(start = 10.dp, end = if (canClose) 2.dp else 10.dp),
        )
        if (canClose) {
            Box(
                modifier = Modifier
                    .size(24.dp)
                    .clickable(onClick = onClose),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Filled.Close,
                    contentDescription = "Close $title",
                    tint = if (isSelected) CmuxAccentGreen else CmuxMuted,
                    modifier = Modifier.size(9.dp),
                )
            }
        }
    }
}

@Composable
private fun NewSurfaceChip(onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .height(28.dp)
            .cmuxSurface(corner = 4.dp, fill = CmuxSurfaceSunken)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text("+ new", style = cmuxDisplay(10f), color = CmuxMuted)
    }
}

// ---------------------------------------------------------------------
// Workspace drawer — iOS WorkspaceDrawer sheet
// ---------------------------------------------------------------------

@Composable
private fun WorkspaceDrawer(
    vm: AppViewModel,
    onPick: (workspaceId: String, surfaceId: String) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("surfaces", style = cmuxDisplay(13f), color = CmuxMuted)
        vm.workspaces.forEach { ws ->
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                CmuxRule(ws.name)
                vm.surfacesFor(ws.id).forEach { surface ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .cmuxSurface(corner = 6.dp, fill = CmuxSurface)
                            .clickable { onPick(ws.id, surface.id) }
                            .padding(horizontal = 12.dp, vertical = 10.dp),
                    ) {
                        Text("▶", style = cmuxDisplay(11f), color = CmuxAccentGreen)
                        Spacer(Modifier.width(10.dp))
                        Text(
                            surface.title,
                            style = cmuxMono(14f, FontWeight.Medium),
                            color = CmuxInk,
                            maxLines = 1,
                        )
                    }
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

// ---------------------------------------------------------------------
// Battery badge — iOS BatteryBadge
// ---------------------------------------------------------------------

@Composable
private fun BatteryBadge(vm: AppViewModel) {
    val text = vm.battery.displayText
    if (text == "--") return
    Text(
        text,
        style = cmuxMono(10f),
        color = if (vm.battery.isCharging) CmuxAccentGreen else CmuxMuted,
        modifier = Modifier
            .cmuxHairline(corner = 3.dp)
            .background(CmuxSurface, RoundedCornerShape(3.dp))
            .clickable { vm.refreshBattery() }
            .padding(horizontal = 5.dp, vertical = 2.dp),
    )
}

// ---------------------------------------------------------------------
// Terminal canvas + ANSI rendering (unchanged rendering core)
// ---------------------------------------------------------------------

/** Live-input diff: send inserted text, backspace for removals, enter for \n. */
private fun liveDiffSend(old: String, new: String, vm: AppViewModel) {
    var p = 0
    while (p < old.length && p < new.length && old[p] == new[p]) p++
    var s = 0
    while (s < old.length - p && s < new.length - p && old[old.length - 1 - s] == new[new.length - 1 - s]) s++
    val removed = old.length - p - s
    val inserted = new.substring(p, new.length - s)
    repeat(removed) { vm.sendKey("backspace") }
    if (inserted.isNotEmpty()) {
        val segments = inserted.split('\n')
        segments.forEachIndexed { i, seg ->
            if (i > 0) vm.sendKey("enter")
            if (seg.isNotEmpty()) vm.sendText(seg)
        }
    }
}

@Composable
private fun TerminalCanvas(vm: AppViewModel, modifier: Modifier = Modifier) {
    val listState = rememberLazyListState()
    val history = vm.historyRows
    val live = vm.frame.rows
    val allRows = history + live
    val historyCount = history.size

    val nearBottom by remember {
        derivedStateOf {
            val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            last >= allRows.size - 4
        }
    }
    var stickToBottom by remember { mutableStateOf(true) }
    val scrollScope = rememberCoroutineScope()
    LaunchedEffect(nearBottom) { stickToBottom = nearBottom }
    LaunchedEffect(vm.frameTick) {
        if (stickToBottom && allRows.isNotEmpty()) {
            listState.scrollToItem(allRows.size - 1)
        }
    }
    LaunchedEffect(allRows.size) {
        if (stickToBottom && allRows.isNotEmpty()) {
            listState.scrollToItem(allRows.size - 1)
        }
    }

    BoxWithConstraints(modifier = modifier) {
        val cols = vm.frame.cols.coerceAtLeast(20)
        val fontSize: TextUnit =
            (maxWidth.value / cols / 0.6f).coerceIn(6f, 16f).sp

        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 6.dp),
        ) {
            item(key = "history-top") {
                if (vm.subscribedSurfaceId != null) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 4.dp),
                        horizontalArrangement = Arrangement.Center,
                    ) {
                        TextButton(
                            onClick = { vm.loadOlderHistory() },
                            enabled = !vm.historyLoading &&
                                (history.isEmpty() || vm.historyNextCursor != null),
                        ) {
                            Text(
                                when {
                                    vm.historyLoading -> "Loading…"
                                    history.isEmpty() -> "Load scrollback"
                                    vm.historyNextCursor != null -> "Load older"
                                    else -> "— scrollback start —"
                                },
                                color = CmuxMuted,
                                style = cmuxMono(11f),
                            )
                        }
                    }
                }
            }
            items(
                count = allRows.size,
                key = { index -> if (index < historyCount) "h$index" else "l${index - historyCount}" },
            ) { index ->
                TerminalLine(
                    text = allRows[index],
                    fontSize = fontSize,
                    isHistory = index < historyCount,
                )
            }
        }

        // scroll-to-bottom button — iOS scrollToBottomButton
        if (!nearBottom) {
            Box(
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(end = 16.dp, bottom = 10.dp)
                    .size(40.dp)
                    .shadow(12.dp, RoundedCornerShape(6.dp))
                    .cmuxSurface(corner = 6.dp, fill = CmuxSurfaceRaised)
                    .clickable {
                        stickToBottom = true
                        scrollScope.launch {
                            if (allRows.isNotEmpty()) listState.scrollToItem(allRows.size - 1)
                        }
                    },
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Filled.KeyboardArrowDown,
                    contentDescription = "Scroll to bottom",
                    tint = CmuxInk,
                    modifier = Modifier.size(14.dp),
                )
            }
        }
    }
}

@Composable
private fun TerminalLine(text: String, fontSize: TextUnit, isHistory: Boolean) {
    val rendered = remember(text) { text.toTerminalAnnotatedString() }
    Text(
        text = rendered,
        fontFamily = FontFamily.Monospace,
        fontSize = fontSize,
        lineHeight = fontSize * 1.15f,
        color = if (isHistory) CmuxMuted else CmuxTerminalText,
        softWrap = false,
        modifier = Modifier.fillMaxWidth(),
    )
}

/** Convert one raw ANSI row into a styled AnnotatedString. */
private fun String.toTerminalAnnotatedString(): AnnotatedString {
    val spans = AnsiParser.parseSpans(this)
    if (spans.isEmpty()) return AnnotatedString("")
    return buildAnnotatedString {
        for (span in spans) {
            val a = span.attr
            var fg = if (a.fg >= 0) Color(a.fg) else CmuxTerminalText
            var bg = if (a.bg >= 0) Color(a.bg) else null
            if (a.inverse) {
                val tmp = fg
                fg = bg ?: CmuxTerminal
                bg = tmp
            }
            if (a.dim) fg = fg.copy(alpha = 0.55f)
            val style = SpanStyle(
                color = fg,
                background = bg ?: Color.Unspecified,
                fontWeight = if (a.bold) FontWeight.Bold else null,
                fontStyle = if (a.italic) FontStyle.Italic else null,
                textDecoration = when {
                    a.underline && a.strike -> TextDecoration.combine(
                        listOf(TextDecoration.Underline, TextDecoration.LineThrough)
                    )
                    a.underline -> TextDecoration.Underline
                    a.strike -> TextDecoration.LineThrough
                    else -> null
                },
            )
            withStyle(style) { append(span.text) }
        }
    }
}
