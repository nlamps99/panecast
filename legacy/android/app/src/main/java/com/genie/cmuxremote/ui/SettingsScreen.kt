package com.genie.cmuxremote.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.genie.cmuxremote.net.ConnectionMode
import com.genie.cmuxremote.state.AppViewModel
import com.genie.cmuxremote.state.ConnectionState
import com.genie.cmuxremote.state.InboxItem
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

private enum class SettingsPage(val icon: ImageVector, val tint: Color, val title: String, val subtitle: String) {
    CONNECTION(Icons.Filled.Link, CmuxAccentBlue, "Connection", "Direct or server, pairing"),
    TERMINAL(Icons.Filled.Terminal, CmuxAccentGreen, "Terminal", "Input mode, shortcut bar"),
    NOTIFICATIONS(Icons.Filled.Notifications, CmuxAccentYellow, "Notifications", "Permission and test"),
    DEVICE(Icons.Filled.Info, CmuxAccentMagenta, "Device", "This phone"),
}

/**
 * Android port of iOS `SettingsView`: grouped menu + detail pages.
 */
@Composable
fun SettingsScreen(vm: AppViewModel) {
    var page by remember { mutableStateOf<SettingsPage?>(null) }

    when (page) {
        null -> SettingsRoot(vm, onOpen = { page = it })
        else -> SettingsDetail(vm, page!!, onBack = { page = null })
    }
}

// ---------------------------------------------------------------------
// Root menu — iOS settingsMenuGroup / settingsMenuItem
// ---------------------------------------------------------------------

@Composable
private fun SettingsRoot(vm: AppViewModel, onOpen: (SettingsPage) -> Unit) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 16.dp, bottom = 96.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Text("settings", style = cmuxDisplay(26f), color = CmuxInk)
            Spacer(Modifier.height(16.dp))
        }

        // COMPUTERS
        item { CmuxRule("Computers") }
        item {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .cmuxSurface()
                    .padding(12.dp),
            ) {
                Icon(
                    Icons.Filled.CheckCircle,
                    contentDescription = null,
                    tint = CmuxAccentGreen,
                    modifier = Modifier.size(20.dp),
                )
                Spacer(Modifier.width(12.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(vm.computerName, style = cmuxMono(15f, FontWeight.Medium), color = CmuxInk)
                    Text(
                        vm.endpoint.baseHttp(),
                        style = cmuxMono(12f),
                        color = CmuxMuted,
                        maxLines = 1,
                    )
                }
            }
        }

        // SETTINGS CONNECTION
        item { CmuxRule("settings connection") }
        item { MenuItem(SettingsPage.CONNECTION, onOpen) }

        // SETTINGS PREFERENCES
        item { CmuxRule("settings preferences") }
        item { MenuItem(SettingsPage.TERMINAL, onOpen) }

        // SETTINGS TOOLS
        item { CmuxRule("settings tools") }
        item { MenuItem(SettingsPage.NOTIFICATIONS, onOpen) }
        item { MenuItem(SettingsPage.DEVICE, onOpen) }
    }
}

@Composable
private fun MenuItem(page: SettingsPage, onOpen: (SettingsPage) -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .cmuxSurface()
            .clickable { onOpen(page) }
            .padding(16.dp),
    ) {
        Box(
            modifier = Modifier
                .size(32.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(page.tint.copy(alpha = 0.14f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(page.icon, contentDescription = null, tint = page.tint, modifier = Modifier.size(15.dp))
        }
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(page.title, style = cmuxMono(15f, FontWeight.Medium), color = CmuxInk)
            Text(page.subtitle, style = cmuxMono(12f), color = CmuxMuted)
        }
        Icon(
            Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = CmuxMutedDim,
            modifier = Modifier.size(16.dp),
        )
    }
}

// ---------------------------------------------------------------------
// Detail pages
// ---------------------------------------------------------------------

@Composable
private fun SettingsDetail(vm: AppViewModel, page: SettingsPage, onBack: () -> Unit) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 96.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.AutoMirrored.Filled.KeyboardArrowLeft,
                    contentDescription = "Back",
                    tint = CmuxMuted,
                    modifier = Modifier
                        .size(20.dp)
                        .clickable(onClick = onBack),
                )
                Spacer(Modifier.width(4.dp))
                Text(page.title, style = cmuxMono(18f, FontWeight.Bold), color = CmuxInk)
            }
        }

        when (page) {
            SettingsPage.CONNECTION -> connectionPage(vm)
            SettingsPage.TERMINAL -> terminalPage(vm)
            SettingsPage.NOTIFICATIONS -> notificationsPage(vm)
            SettingsPage.DEVICE -> devicePage(vm)
        }
    }
}

// ---------------------------------------------------------------------
// Connection — iOS connectionSettings
// ---------------------------------------------------------------------

private fun androidx.compose.foundation.lazy.LazyListScope.connectionPage(vm: AppViewModel) {
    item { CmuxRule("connection") }

    item {
        // mode picker — iOS segmented Picker
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .cmuxSurface(corner = 8.dp, fill = CmuxSurfaceSunken)
                .padding(4.dp),
        ) {
            ConnectionMode.entries.forEach { m ->
                val selected = vm.mode == m
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .height(34.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .background(if (selected) CmuxSurfaceRaised else Color.Transparent)
                        .clickable { vm.mode = m },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        m.label,
                        style = cmuxMono(13f, FontWeight.Medium),
                        color = if (selected) CmuxInk else CmuxMuted,
                    )
                }
            }
        }
    }

    if (vm.mode == ConnectionMode.DIRECT) {
        item { FieldLabel("host") }
        item {
            SettingsField(
                value = vm.host,
                onChange = { vm.host = it },
                placeholder = "192.168.x.x, mac.local, or 100.x.x.x",
                keyboardType = KeyboardType.Uri,
            )
        }
        item { FieldLabel("port") }
        item {
            SettingsField(
                value = vm.port.toString(),
                onChange = { vm.port = it.toIntOrNull() ?: vm.port },
                placeholder = "4399",
                keyboardType = KeyboardType.Number,
            )
        }
        item {
            Text(
                "LAN traffic is not encrypted. Use it only on a network you trust.",
                style = cmuxMono(12f),
                color = CmuxAccentYellow,
            )
        }
    } else {
        item { FieldLabel("server url") }
        item {
            SettingsField(
                value = vm.brokerUrl,
                onChange = { vm.brokerUrl = it },
                placeholder = "https://relay.example.com",
                keyboardType = KeyboardType.Uri,
            )
        }
        item { FieldLabel("relay id") }
        item {
            SettingsField(vm.relayId, { vm.relayId = it }, placeholder = "home-mac")
        }
        item { FieldLabel("pairing code") }
        item {
            SettingsField(
                vm.pairingCode,
                { vm.pairingCode = it },
                placeholder = "One-time pairing secret",
                secret = true,
            )
        }
        item { ScanQrButton(vm) }
    }

    // status row
    item {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(7.dp)
                    .clip(RoundedCornerShape(4.dp))
                    .background(connectionColor(vm.connectionState)),
            )
            Spacer(Modifier.width(8.dp))
            Text(
                connectionSubtitle(vm.connectionState),
                style = cmuxMono(12f),
                color = CmuxMuted,
            )
            vm.transportLabel?.let {
                if (vm.connectionState == ConnectionState.CONNECTED) {
                    Spacer(Modifier.width(8.dp))
                    Text(it, style = cmuxMono(10f), color = CmuxMuted)
                }
            }
        }
    }

    if (vm.connectionState == ConnectionState.ERROR) {
        item {
            Text(
                vm.connectionError ?: "Connection failed",
                style = cmuxMono(11f),
                color = CmuxAccentRed,
            )
        }
    }

    item {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 36.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(CmuxAccentGreen)
                .clickable { vm.saveSettings(); vm.connect() }
                .padding(horizontal = 12.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text("[ SAVE & RECONNECT ]", style = cmuxDisplay(12f), color = CmuxCanvas)
        }
    }

    item {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 36.dp)
                .cmuxSurface(corner = 6.dp, fill = CmuxSurfaceSunken, border = CmuxAccentRed.copy(alpha = 0.5f))
                .clickable { vm.disconnect() }
                .padding(horizontal = 12.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text("[ DISCONNECT ]", style = cmuxDisplay(12f), color = CmuxAccentRed)
        }
    }
}

@Composable
private fun ScanQrButton(vm: AppViewModel) {
    val context = LocalContext.current
    var scanError by remember { mutableStateOf<String?>(null) }
    var confirmation by remember { mutableStateOf<String?>(null) }

    val scanLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result?.contents ?: return@rememberLauncherForActivityResult
        if (vm.applyPairingLink(contents)) {
            scanError = null
            confirmation = "scanned ${vm.relayId} — tap save & reconnect"
        } else {
            scanError = "Not a pairing QR code"
        }
    }
    val cameraPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) launchScan(scanLauncher) else scanError = "Camera permission is required to scan"
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 36.dp)
                .cmuxSurface(corner = 6.dp, fill = CmuxSurfaceSunken)
                .clickable {
                    if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA)
                        == PackageManager.PERMISSION_GRANTED
                    ) launchScan(scanLauncher)
                    else cameraPermission.launch(Manifest.permission.CAMERA)
                }
                .padding(horizontal = 12.dp),
            contentAlignment = Alignment.Center,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Filled.QrCodeScanner,
                    contentDescription = null,
                    tint = CmuxInk,
                    modifier = Modifier.size(12.dp),
                )
                Spacer(Modifier.width(8.dp))
                Text("[ SCAN QR FROM MAC ]", style = cmuxDisplay(12f), color = CmuxInk)
            }
        }
        confirmation?.let { Text(it, style = cmuxMono(12f), color = CmuxAccentGreen) }
        scanError?.let { Text(it, style = cmuxMono(12f), color = CmuxAccentRed) }
    }
}

private fun launchScan(launcher: androidx.activity.result.ActivityResultLauncher<ScanOptions>) {
    launcher.launch(
        ScanOptions()
            .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            .setPrompt("Scan the QR shown by `cmux-relay pair`")
            .setBeepEnabled(false)
            .setOrientationLocked(false)
    )
}

// ---------------------------------------------------------------------
// Terminal preferences — iOS interactionSettings subset
// ---------------------------------------------------------------------

private fun androidx.compose.foundation.lazy.LazyListScope.terminalPage(vm: AppViewModel) {
    item { CmuxRule("terminal") }
    item {
        PrefToggle(
            title = "Default live input",
            subtitle = "Send each keystroke immediately instead of composing commands",
            checked = vm.defaultLiveInput,
        ) {
            vm.defaultLiveInput = it
            vm.liveInputMode = it
            vm.saveSettings()
        }
    }
    item {
        PrefToggle(
            title = "Show shortcut bar",
            subtitle = "esc, ^C, arrows and / shortcuts under the input field",
            checked = vm.showShortcutBar,
        ) { vm.showShortcutBar = it; vm.saveSettings() }
    }
    item {
        PrefToggle(
            title = "Keep keyboard after submit",
            subtitle = "Don't hide the keyboard after [ ENTER ]",
            checked = vm.keepKeyboardAfterSubmit,
        ) { vm.keepKeyboardAfterSubmit = it; vm.saveSettings() }
    }
    item {
        PrefToggle(
            title = "Live input now",
            subtitle = "Current session input mode",
            checked = vm.liveInputMode,
        ) { vm.liveInputMode = it }
    }
}

@Composable
private fun PrefToggle(
    title: String,
    subtitle: String,
    checked: Boolean,
    onChange: (Boolean) -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .cmuxSurface()
            .padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(title, style = cmuxMono(15f, FontWeight.Medium), color = CmuxInk)
            Text(subtitle, style = cmuxMono(12f), color = CmuxMuted)
        }
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            colors = SwitchDefaults.colors(
                checkedTrackColor = CmuxAccentGreen,
                checkedThumbColor = CmuxCanvas,
                uncheckedTrackColor = CmuxSurfaceSunken,
                uncheckedThumbColor = CmuxMuted,
                uncheckedBorderColor = CmuxDivider,
            ),
        )
    }
}

// ---------------------------------------------------------------------
// Notifications — iOS notificationSettings
// ---------------------------------------------------------------------

private fun androidx.compose.foundation.lazy.LazyListScope.notificationsPage(vm: AppViewModel) {
    item { CmuxRule("notifications") }
    item {
        Text(
            "Manage notification permission, banners, and sounds in Android Settings.",
            style = cmuxMono(12f),
            color = CmuxMuted,
        )
    }
    item {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 36.dp)
                .cmuxSurface(corner = 6.dp, fill = CmuxSurfaceSunken)
                .clickable {
                    vm.onNotification?.invoke(
                        InboxItem(
                            id = "test-${System.currentTimeMillis()}",
                            workspaceId = "local",
                            surfaceId = null,
                            title = "cmux remote",
                            subtitle = null,
                            body = "Test notification",
                            ts = System.currentTimeMillis() / 1000,
                            requiresInput = false,
                        )
                    )
                }
                .padding(horizontal = 12.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text("[ SEND TEST NOTIFICATION ]", style = cmuxDisplay(12f), color = CmuxInk)
        }
    }
}

// ---------------------------------------------------------------------
// Device — iOS deviceSettings
// ---------------------------------------------------------------------

private fun androidx.compose.foundation.lazy.LazyListScope.devicePage(vm: AppViewModel) {
    item { CmuxRule("device") }
    item {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .cmuxSurface()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            InfoRow("name", android.os.Build.MODEL ?: "Android")
            InfoRow("device id", vm.clientId.take(13) + "…")
            InfoRow("endpoint", vm.endpoint.baseHttp())
            InfoRow("version", "1.0.0")
        }
    }
    item {
        var confirmForget by remember { mutableStateOf(false) }
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 36.dp)
                    .cmuxSurface(corner = 6.dp, fill = CmuxSurfaceSunken, border = CmuxAccentRed.copy(alpha = 0.5f))
                    .clickable { confirmForget = true }
                    .padding(horizontal = 12.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text("[ FORGET THIS COMPUTER ]", style = cmuxDisplay(12f), color = CmuxAccentRed)
            }
            if (confirmForget) {
                AlertDialog(
                    onDismissRequest = { confirmForget = false },
                    containerColor = CmuxSurface,
                    title = { Text("Remove Computer", style = cmuxMono(15f, FontWeight.Bold), color = CmuxInk) },
                    text = {
                        Text(
                            "Clears saved credentials and pairing. Scan the QR again to reconnect.",
                            style = cmuxMono(12f),
                            color = CmuxInkDim,
                        )
                    },
                    confirmButton = {
                        TextButton(onClick = { confirmForget = false; vm.forgetComputer() }) {
                            Text("Remove", color = CmuxAccentRed, style = cmuxDisplay(11f))
                        }
                    },
                    dismissButton = {
                        TextButton(onClick = { confirmForget = false }) {
                            Text("Cancel", color = CmuxMuted, style = cmuxDisplay(11f))
                        }
                    },
                )
            }
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row {
        Text(label.uppercase(), style = cmuxDisplay(10f), color = CmuxMuted, modifier = Modifier.width(90.dp))
        Text(value, style = cmuxMono(12f), color = CmuxInk, maxLines = 1)
    }
}

// ---------------------------------------------------------------------
// Shared field components
// ---------------------------------------------------------------------

@Composable
private fun FieldLabel(text: String) {
    Text(text.uppercase(), style = cmuxDisplay(10f), color = CmuxMuted)
}

@Composable
private fun SettingsField(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String = "",
    keyboardType: KeyboardType = KeyboardType.Text,
    secret: Boolean = false,
) {
    BasicTextField(
        value = value,
        onValueChange = onChange,
        textStyle = cmuxMono(14f).copy(color = CmuxInk),
        cursorBrush = SolidColor(CmuxAccentGreen),
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
        visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
        modifier = Modifier
            .fillMaxWidth()
            .cmuxSurface(corner = 8.dp, fill = CmuxSurfaceSunken)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        decorationBox = { inner ->
            Box {
                if (value.isEmpty() && placeholder.isNotEmpty()) {
                    Text(placeholder, style = cmuxMono(14f), color = CmuxMuted)
                }
                inner()
            }
        },
    )
}
