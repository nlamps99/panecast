package com.genie.cmuxremote.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.LockOpen
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.genie.cmuxremote.state.AppViewModel
import com.genie.cmuxremote.state.ConnectionState
import com.genie.cmuxremote.state.CmuxWindow
import com.genie.cmuxremote.state.Workspace
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Android port of iOS `WorkspaceListView`.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspaceListScreen(
    vm: AppViewModel,
    onSelect: (Workspace) -> Unit,
) {
    var showCreate by remember { mutableStateOf(false) }
    var newName by remember { mutableStateOf("") }
    var searchText by remember { mutableStateOf("") }
    var renameTarget by remember { mutableStateOf<Workspace?>(null) }
    var closeTarget by remember { mutableStateOf<Workspace?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    val query = searchText.trim()
    val filtered = if (query.isEmpty()) vm.workspaces
    else vm.workspaces.filter { it.name.contains(query, ignoreCase = true) }

    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = {
            refreshing = true
            vm.refresh()
            scope.launch { delay(700); refreshing = false }
        },
        modifier = Modifier.fillMaxSize(),
    ) {
        LazyVerticalGrid(
            columns = GridCells.Adaptive(minSize = 300.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 18.dp),
        ) {
            item(span = { androidx.compose.foundation.lazy.grid.GridItemSpan(maxLineSpan) }) {
                Column(
                    modifier = Modifier.padding(top = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(18.dp),
                ) {
                    // header — "cmux remote" + plus
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("cmux", style = cmuxDisplay(28f), color = CmuxInk)
                        Spacer(Modifier.width(8.dp))
                        Text("remote", style = cmuxDisplay(28f), color = CmuxAccentGreen)
                        Spacer(Modifier.weight(1f))
                        SquareIconButton(icon = Icons.Filled.Add, desc = "New workspace") {
                            newName = ""
                            showCreate = true
                        }
                    }

                    // connection subtitle + transport badge
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            modifier = Modifier
                                .size(6.dp)
                                .clip(RoundedCornerShape(3.dp))
                                .background(connectionColor(vm.connectionState)),
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            connectionSubtitle(vm.connectionState),
                            style = cmuxMono(11f),
                            color = CmuxMuted,
                        )
                        vm.transportLabel?.let { label ->
                            if (vm.connectionState == ConnectionState.CONNECTED) {
                                Spacer(Modifier.width(8.dp))
                                TransportBadge(label)
                            }
                        }
                        if (vm.reconnecting) {
                            Spacer(Modifier.width(8.dp))
                            CircularProgressIndicator(
                                modifier = Modifier.size(12.dp),
                                strokeWidth = 1.5.dp,
                                color = CmuxMuted,
                            )
                        }
                    }

                    // window switcher — only when cmux reports >1 window
                    if (vm.windows.size > 1) {
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            CmuxRule("windows")
                            Row(
                                modifier = Modifier.horizontalScroll(rememberScrollState()),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                vm.windows.forEach { w -> WindowChip(vm, w) }
                            }
                        }
                    }

                    // search bar — "/" + filter…
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(44.dp)
                            .cmuxSurface(corner = 8.dp, fill = CmuxSurfaceSunken)
                            .padding(horizontal = 14.dp),
                    ) {
                        Text("/", style = cmuxDisplay(14f), color = CmuxAccentGreen)
                        Spacer(Modifier.width(10.dp))
                        BasicTextField(
                            value = searchText,
                            onValueChange = { searchText = it },
                            textStyle = cmuxMono(14f).copy(color = CmuxInk),
                            cursorBrush = SolidColor(CmuxAccentGreen),
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                            decorationBox = { inner ->
                                Box {
                                    if (searchText.isEmpty()) {
                                        Text("filter…", style = cmuxMono(14f), color = CmuxMuted)
                                    }
                                    inner()
                                }
                            },
                        )
                    }

                    CmuxRule("workspaces")
                }
            }

            items(filtered, key = { it.id }) { ws ->
                WorkspaceCard(
                    workspace = ws,
                    surfaceCount = vm.surfacesFor(ws.id).size,
                    unreadCount = vm.unreadByWorkspace[ws.id] ?: 0,
                    isSelected = vm.selectedWorkspaceId == ws.id,
                    onOpen = {
                        vm.selectWorkspace(ws.id)
                        onSelect(ws)
                    },
                    onRename = { renameTarget = ws },
                    onClose = { closeTarget = ws },
                )
            }

            if (filtered.isEmpty()) {
                item(span = { androidx.compose.foundation.lazy.grid.GridItemSpan(maxLineSpan) }) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 40.dp),
                    ) {
                        Text("[ no workspaces ]", style = cmuxDisplay(13f), color = CmuxMuted)
                        Spacer(Modifier.height(10.dp))
                        Text(
                            "pull to refresh — check relay connection",
                            style = cmuxMono(11f),
                            color = CmuxMuted,
                        )
                    }
                }
            }

            item(span = { androidx.compose.foundation.lazy.grid.GridItemSpan(maxLineSpan) }) {
                Spacer(Modifier.height(96.dp)) // clearance above the floating tab bar
            }
        }
    }

    // ---- dialogs ------------------------------------------------------

    if (showCreate) {
        AlertDialog(
            onDismissRequest = { showCreate = false },
            containerColor = CmuxSurface,
            title = { Text("New Workspace", style = cmuxMono(15f, FontWeight.Bold), color = CmuxInk) },
            text = {
                BasicTextField(
                    value = newName,
                    onValueChange = { newName = it },
                    textStyle = cmuxMono(14f).copy(color = CmuxInk),
                    cursorBrush = SolidColor(CmuxAccentGreen),
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .cmuxSurface(corner = 8.dp, fill = CmuxSurfaceSunken)
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                    decorationBox = { inner ->
                        Box {
                            if (newName.isEmpty()) {
                                Text("name", style = cmuxMono(14f), color = CmuxMuted)
                            }
                            inner()
                        }
                    },
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val name = newName.trim()
                    if (name.isNotEmpty()) vm.createWorkspace(name)
                    showCreate = false
                }) { Text("Create", color = CmuxAccentGreen, style = cmuxDisplay(11f)) }
            },
            dismissButton = {
                TextButton(onClick = { showCreate = false }) {
                    Text("Cancel", color = CmuxMuted, style = cmuxDisplay(11f))
                }
            },
        )
    }

    renameTarget?.let { ws ->
        var name by remember(ws.id) { mutableStateOf(ws.name) }
        AlertDialog(
            onDismissRequest = { renameTarget = null },
            containerColor = CmuxSurface,
            title = { Text("Rename Workspace", style = cmuxMono(15f, FontWeight.Bold), color = CmuxInk) },
            text = {
                BasicTextField(
                    value = name,
                    onValueChange = { name = it },
                    textStyle = cmuxMono(14f).copy(color = CmuxInk),
                    cursorBrush = SolidColor(CmuxAccentGreen),
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .cmuxSurface(corner = 8.dp, fill = CmuxSurfaceSunken)
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val title = name.trim()
                    if (title.isNotEmpty()) vm.renameWorkspace(ws.id, title)
                    renameTarget = null
                }) { Text("Rename", color = CmuxAccentGreen, style = cmuxDisplay(11f)) }
            },
            dismissButton = {
                TextButton(onClick = { renameTarget = null }) {
                    Text("Cancel", color = CmuxMuted, style = cmuxDisplay(11f))
                }
            },
        )
    }

    closeTarget?.let { ws ->
        AlertDialog(
            onDismissRequest = { closeTarget = null },
            containerColor = CmuxSurface,
            title = { Text("Close workspace?", style = cmuxMono(15f, FontWeight.Bold), color = CmuxInk) },
            text = {
                Text(
                    "Close ${ws.name}? This closes the workspace in cmux.",
                    style = cmuxMono(12f),
                    color = CmuxInkDim,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    vm.closeWorkspace(ws.id)
                    closeTarget = null
                }) { Text("Close ${ws.name}", color = CmuxAccentRed, style = cmuxDisplay(11f)) }
            },
            dismissButton = {
                TextButton(onClick = { closeTarget = null }) {
                    Text("Cancel", color = CmuxMuted, style = cmuxDisplay(11f))
                }
            },
        )
    }
}

// ---------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------

@Composable
fun SquareIconButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    desc: String,
    tint: Color = CmuxInk,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(36.dp)
            .cmuxSurface(corner = 6.dp, fill = CmuxSurfaceRaised)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = desc, tint = tint, modifier = Modifier.size(16.dp))
    }
}

@Composable
private fun TransportBadge(label: String) {
    val plaintext = label == "LAN"
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .cmuxHairline(
                color = if (plaintext) CmuxAccentYellow.copy(alpha = 0.35f) else CmuxDivider,
                corner = 3.dp,
            )
            .background(CmuxSurfaceSunken, RoundedCornerShape(3.dp))
            .padding(horizontal = 5.dp, vertical = 2.dp),
    ) {
        Icon(
            if (plaintext) Icons.Filled.LockOpen else Icons.Filled.Lock,
            contentDescription = null,
            tint = if (plaintext) CmuxAccentYellow else CmuxMuted,
            modifier = Modifier.size(8.dp),
        )
        Spacer(Modifier.width(3.dp))
        Text(
            label,
            style = cmuxMono(10f),
            color = if (plaintext) CmuxAccentYellow else CmuxMuted,
        )
    }
}

@Composable
private fun WindowChip(vm: AppViewModel, window: CmuxWindow) {
    val selected = vm.selectedWindowId == window.id
    val base = if (window.ref.startsWith("window:")) "win " + window.ref.removePrefix("window:")
    else window.ref
    val label = if (window.isKey) "$base ●" else base

    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .height(34.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(if (selected) CmuxAccentGreen else CmuxSurfaceSunken)
            .cmuxHairline(color = if (selected) Color.Transparent else CmuxDivider, corner = 6.dp)
            .clickable(enabled = !selected) { vm.selectWindow(window.id) }
            .padding(horizontal = 12.dp),
    ) {
        Text(label, style = cmuxDisplay(11f), color = if (selected) CmuxCanvas else CmuxInk)
        Spacer(Modifier.width(6.dp))
        Text(
            "${window.workspaceCount}",
            style = cmuxMono(10f),
            color = if (selected) CmuxCanvas.copy(alpha = 0.75f) else CmuxMuted,
        )
    }
}

@Composable
private fun WorkspaceCard(
    workspace: Workspace,
    surfaceCount: Int,
    unreadCount: Int,
    isSelected: Boolean,
    onOpen: () -> Unit,
    onRename: () -> Unit,
    onClose: () -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 70.dp)
            .cmuxSurface(
                corner = 8.dp,
                fill = if (isSelected) CmuxSurfaceRaised else CmuxSurface,
            )
            .padding(horizontal = 14.dp, vertical = 12.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .weight(1f)
                .clickable(onClick = onOpen),
        ) {
            // index box
            Box(
                modifier = Modifier
                    .size(44.dp)
                    .cmuxSurface(
                        corner = 6.dp,
                        fill = CmuxSurfaceSunken,
                        border = if (isSelected) CmuxAccentGreen else CmuxDivider,
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "%02d".format(workspace.index + 1),
                    style = cmuxDisplay(13f),
                    color = if (isSelected) CmuxAccentGreen else CmuxMuted,
                )
            }
            Spacer(Modifier.width(14.dp))
            Column {
                Text(
                    workspace.name,
                    style = cmuxMono(15f, FontWeight.Medium),
                    color = CmuxInk,
                    maxLines = 1,
                )
                Spacer(Modifier.height(4.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("$surfaceCount", style = cmuxDisplay(11f), color = CmuxAccentBlue)
                    Spacer(Modifier.width(6.dp))
                    Text("surfaces", style = cmuxMono(11f), color = CmuxMuted)
                }
            }
            if (unreadCount > 0) {
                Spacer(Modifier.width(10.dp))
                Text(
                    if (unreadCount > 99) "99+" else "$unreadCount",
                    style = cmuxDisplay(9f),
                    color = CmuxCanvas,
                    modifier = Modifier
                        .clip(RoundedCornerShape(3.dp))
                        .background(CmuxAccentRed)
                        .padding(horizontal = 5.dp, vertical = 1.dp),
                )
            }
            if (isSelected) {
                Spacer(Modifier.width(10.dp))
                Text("→", style = cmuxDisplay(16f), color = CmuxAccentGreen)
            }
        }

        Spacer(Modifier.width(10.dp))
        CardIconButton(icon = Icons.Filled.Edit, desc = "Rename ${workspace.name}", onClick = onRename)
        Spacer(Modifier.width(6.dp))
        CardIconButton(icon = Icons.Filled.Close, desc = "Close ${workspace.name}", onClick = onClose)
    }
}

@Composable
private fun CardIconButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    desc: String,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(34.dp)
            .cmuxSurface(corner = 6.dp, fill = CmuxSurfaceSunken)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = desc, tint = CmuxMuted, modifier = Modifier.size(12.dp))
    }
}
