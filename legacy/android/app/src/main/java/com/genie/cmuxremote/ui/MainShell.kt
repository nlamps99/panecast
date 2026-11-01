package com.genie.cmuxremote.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.genie.cmuxremote.state.AppViewModel
import com.genie.cmuxremote.state.InboxItem

enum class AppTab(val title: String, val icon: ImageVector) {
    WORKSPACES("Workspaces", Icons.Filled.Layers),
    ACTIVE("Active", Icons.Filled.Terminal),
    INBOX("Inbox", Icons.Filled.Notifications),
    SETTINGS("Settings", Icons.Filled.Settings),
}

/**
 * Android port of iOS `ContentView`: computer switcher on top, floating tab
 * bar on the bottom, four tab destinations. The tab bar hides on ACTIVE so
 * the terminal gets the full screen like on iOS.
 */
@Composable
fun MainShell(vm: AppViewModel) {
    var selectedTab by remember { mutableStateOf(AppTab.WORKSPACES) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(CmuxCanvas),
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            if (selectedTab != AppTab.ACTIVE) {
                ComputerSwitcher(
                    name = vm.computerName,
                    onManage = { selectedTab = AppTab.SETTINGS },
                    modifier = Modifier.statusBarsPadding(),
                )
            }
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth(),
            ) {
                when (selectedTab) {
                    AppTab.WORKSPACES -> WorkspaceListScreen(
                        vm = vm,
                        onSelect = { ws ->
                            vm.markWorkspaceSeen(ws.id)
                            selectedTab = AppTab.ACTIVE
                        },
                    )
                    AppTab.ACTIVE -> TerminalScreen(
                        vm = vm,
                        onBack = { selectedTab = AppTab.WORKSPACES },
                    )
                    AppTab.INBOX -> InboxScreen(
                        vm = vm,
                        onOpenItem = { item: InboxItem ->
                            if (vm.openInboxItem(item)) {
                                selectedTab = AppTab.ACTIVE
                            }
                        },
                    )
                    AppTab.SETTINGS -> SettingsScreen(vm = vm)
                }
            }
        }

        if (selectedTab != AppTab.ACTIVE) {
            FloatingTabBar(
                selected = selectedTab,
                inboxCount = vm.unreadInbox,
                onSelect = { selectedTab = it },
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .navigationBarsPadding()
                    .padding(horizontal = 20.dp)
                    .padding(bottom = 14.dp),
            )
        }
    }
}

// ---------------------------------------------------------------------
// Computer switcher — iOS `computerSwitcher`
// ---------------------------------------------------------------------

@Composable
private fun ComputerSwitcher(
    name: String,
    onManage: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var menuOpen by remember { mutableStateOf(false) }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(CmuxSurface)
            .padding(horizontal = 20.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .clickable { menuOpen = true }
                    .padding(vertical = 10.dp),
            ) {
                Icon(
                    Icons.Filled.Computer,
                    contentDescription = null,
                    tint = CmuxInk,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.width(8.dp))
                Text(name, style = cmuxMono(13f), color = CmuxInk, maxLines = 1)
                Spacer(Modifier.width(4.dp))
                Icon(
                    Icons.Filled.KeyboardArrowDown,
                    contentDescription = null,
                    tint = CmuxInk,
                    modifier = Modifier.size(14.dp),
                )
            }
            DropdownMenu(
                expanded = menuOpen,
                onDismissRequest = { menuOpen = false },
                modifier = Modifier.background(CmuxSurfaceRaised),
            ) {
                DropdownMenuItem(
                    text = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                Icons.Filled.Check,
                                contentDescription = null,
                                tint = CmuxAccentGreen,
                                modifier = Modifier.size(16.dp),
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(name, style = cmuxMono(13f), color = CmuxInk)
                        }
                    },
                    onClick = { menuOpen = false },
                )
                DropdownMenuItem(
                    text = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                Icons.Filled.Settings,
                                contentDescription = null,
                                tint = CmuxMuted,
                                modifier = Modifier.size(16.dp),
                            )
                            Spacer(Modifier.width(8.dp))
                            Text("Manage Computers", style = cmuxMono(13f), color = CmuxInk)
                        }
                    },
                    onClick = {
                        menuOpen = false
                        onManage()
                    },
                )
            }
        }
        Spacer(Modifier.weight(1f))
    }
}

// ---------------------------------------------------------------------
// Floating tab bar — iOS `FloatingTabBar`
// ---------------------------------------------------------------------

@Composable
private fun FloatingTabBar(
    selected: AppTab,
    inboxCount: Int,
    onSelect: (AppTab) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .shadow(24.dp, RoundedCornerShape(12.dp))
            .cmuxSurface(corner = 12.dp, fill = CmuxSurface)
            .padding(6.dp),
    ) {
        AppTab.entries.forEach { tab ->
            val isSelected = selected == tab
            Box(
                modifier = Modifier
                    .weight(1f)
                    .height(58.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(if (isSelected) CmuxSurfaceRaised else Color.Transparent)
                    .clickable { onSelect(tab) },
                contentAlignment = Alignment.Center,
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(
                        tab.icon,
                        contentDescription = tab.title,
                        tint = if (isSelected) CmuxAccentGreen else CmuxMuted,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        tab.title.uppercase(),
                        style = cmuxDisplay(9f),
                        color = if (isSelected) CmuxAccentGreen else CmuxMuted,
                    )
                }
                if (tab == AppTab.INBOX && inboxCount > 0) {
                    Text(
                        if (inboxCount > 99) "99+" else "$inboxCount",
                        style = cmuxDisplay(9f),
                        color = CmuxCanvas,
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .padding(top = 6.dp, end = 14.dp)
                            .clip(RoundedCornerShape(3.dp))
                            .background(CmuxAccentRed)
                            .padding(horizontal = 5.dp),
                    )
                }
            }
        }
    }
}
