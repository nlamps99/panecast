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
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.genie.cmuxremote.net.ConnectionMode
import com.genie.cmuxremote.state.AppViewModel
import com.genie.cmuxremote.state.ConnectionState
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

/**
 * First-run pairing screen (Android-only entry point — iOS pairs from
 * Settings). Once an endpoint is configured the app shows the tab shell.
 */
@Composable
fun ConnectScreen(vm: AppViewModel) {
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    var scanError by remember { mutableStateOf<String?>(null) }

    val scanLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result?.contents
        if (contents.isNullOrEmpty()) return@rememberLauncherForActivityResult
        if (vm.applyPairingLink(contents)) {
            scanError = null
            vm.connect()
        } else {
            scanError = "Not a pairing QR code"
        }
    }
    val cameraPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) launchQrScan(scanLauncher)
        else scanError = "Camera permission is required to scan"
    }
    val startScan = {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED
        ) launchQrScan(scanLauncher)
        else cameraPermission.launch(Manifest.permission.CAMERA)
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .verticalScroll(rememberScrollState())
            .imePadding()
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Spacer(Modifier.height(24.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("cmux", style = cmuxDisplay(28f), color = CmuxInk)
            Spacer(Modifier.width(8.dp))
            Text("remote", style = cmuxDisplay(28f), color = CmuxAccentGreen)
        }
        Text(
            "Control cmux terminals on your Mac",
            style = cmuxMono(13f),
            color = CmuxMuted,
        )
        Spacer(Modifier.height(8.dp))

        // primary action — scan the QR printed by `cmux-relay pair`
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 44.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(CmuxAccentGreen)
                .clickable { startScan() }
                .padding(horizontal = 12.dp),
            contentAlignment = Alignment.Center,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Filled.QrCodeScanner,
                    contentDescription = null,
                    tint = CmuxCanvas,
                    modifier = Modifier.size(14.dp),
                )
                Spacer(Modifier.width(8.dp))
                Text("[ SCAN QR TO PAIR ]", style = cmuxDisplay(13f), color = CmuxCanvas)
            }
        }

        scanError?.let { Text(it, color = CmuxAccentRed, style = cmuxMono(12f)) }

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 36.dp)
                .cmuxSurface(corner = 6.dp, fill = CmuxSurfaceSunken)
                .clickable {
                    clipboard.getText()?.text?.let { text ->
                        if (vm.applyPairingLink(text)) vm.connect()
                        else scanError = "Clipboard does not contain a cmux://pair link"
                    }
                }
                .padding(horizontal = 12.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text("[ PASTE cmux://pair LINK ]", style = cmuxDisplay(11f), color = CmuxInk)
        }

        CmuxRule("manual setup")

        // mode picker
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

        if (vm.mode == ConnectionMode.DIRECT) {
            ConnectField(vm.host, { vm.host = it }, "Host — 192.168.x.x or 100.x.x.x", KeyboardType.Uri)
            ConnectField(vm.port.toString(), { vm.port = it.toIntOrNull() ?: vm.port }, "Port", KeyboardType.Number)
        } else {
            ConnectField(vm.brokerUrl, { vm.brokerUrl = it }, "Server URL — https://relay.example.com", KeyboardType.Uri)
            ConnectField(vm.relayId, { vm.relayId = it }, "Relay ID")
            ConnectField(vm.pairingCode, { vm.pairingCode = it }, "Pairing code")
        }

        if (vm.connectionState == ConnectionState.ERROR) {
            Text(
                vm.connectionError ?: "Connection failed",
                color = CmuxAccentRed,
                style = cmuxMono(12f),
            )
        }

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 44.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(
                    if (vm.connectionState == ConnectionState.CONNECTING) CmuxMuted
                    else CmuxAccentBlue
                )
                .clickable(enabled = vm.connectionState != ConnectionState.CONNECTING) {
                    vm.connect()
                }
                .padding(horizontal = 12.dp),
            contentAlignment = Alignment.Center,
        ) {
            if (vm.connectionState == ConnectionState.CONNECTING) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(14.dp),
                        strokeWidth = 2.dp,
                        color = CmuxCanvas,
                    )
                    Spacer(Modifier.width(8.dp))
                    Text("CONNECTING…", style = cmuxDisplay(12f), color = CmuxCanvas)
                }
            } else {
                Text("[ CONNECT ]", style = cmuxDisplay(13f), color = CmuxCanvas)
            }
        }

        if (vm.connectionState == ConnectionState.ERROR) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { vm.forgetCredentials(); vm.connect() }
                    .padding(vertical = 8.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "Re-pair (forget saved credentials)",
                    style = cmuxMono(12f),
                    color = CmuxMuted,
                )
            }
        }
    }
}

private fun launchQrScan(launcher: androidx.activity.result.ActivityResultLauncher<ScanOptions>) {
    launcher.launch(
        ScanOptions()
            .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            .setPrompt("Scan the QR shown by `cmux-relay pair`")
            .setBeepEnabled(false)
            .setOrientationLocked(false)
    )
}

@Composable
private fun ConnectField(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    keyboardType: KeyboardType = KeyboardType.Text,
) {
    BasicTextField(
        value = value,
        onValueChange = onChange,
        textStyle = cmuxMono(14f).copy(color = CmuxInk),
        cursorBrush = SolidColor(CmuxAccentGreen),
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
        modifier = Modifier
            .fillMaxWidth()
            .cmuxSurface(corner = 8.dp, fill = CmuxSurfaceSunken)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        decorationBox = { inner ->
            Box {
                if (value.isEmpty()) {
                    Text(placeholder, style = cmuxMono(14f), color = CmuxMuted)
                }
                inner()
            }
        },
    )
}
