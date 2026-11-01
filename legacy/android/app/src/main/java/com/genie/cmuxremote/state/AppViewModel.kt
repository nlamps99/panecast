package com.genie.cmuxremote.state

import android.app.Application
import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.genie.cmuxremote.net.ConnectionMode
import com.genie.cmuxremote.net.DeviceCredentials
import com.genie.cmuxremote.net.PairingPayload
import com.genie.cmuxremote.net.PushFrame
import com.genie.cmuxremote.net.RelayClient
import com.genie.cmuxremote.net.RelayEndpoint
import com.genie.cmuxremote.net.RelayHttpException
import com.genie.cmuxremote.net.RpcException
import com.genie.cmuxremote.net.optStringOrNull
import com.genie.cmuxremote.net.rpcParams
import com.genie.cmuxremote.net.stringLeaves
import com.genie.cmuxremote.term.ScreenState
import java.util.UUID
import kotlinx.coroutines.launch
import org.json.JSONObject

// ---------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------

data class CmuxWindow(val id: String, val ref: String, val index: Int, val workspaceCount: Int, val isKey: Boolean)
data class Workspace(val id: String, val name: String, val index: Int)
data class Surface(val id: String, val title: String, val index: Int)

/** Immutable terminal snapshot published to the UI. */
data class TerminalFrame(
    val rows: List<String> = emptyList(),
    val cols: Int = 80,
    val rev: Int = 0,
    val cursorX: Int = 0,
    val cursorY: Int = 0,
)

data class InboxItem(
    val id: String,
    val workspaceId: String,
    val surfaceId: String?,
    val title: String,
    val subtitle: String?,
    val body: String,
    val ts: Long,
    val requiresInput: Boolean,
)

data class HostBattery(
    val available: Boolean = false,
    val percent: Int? = null,
    val isCharging: Boolean = false,
    val powerSource: String? = null,
) {
    val displayText: String
        get() = when {
            available && percent != null -> if (isCharging) "$percent% ⚡" else "$percent%"
            powerSource == "AC Power" -> "AC"
            else -> "--"
        }
}

enum class ConnectionState { DISCONNECTED, CONNECTING, CONNECTED, ERROR }

sealed interface InputStatus {
    data object Idle : InputStatus
    data object Sending : InputStatus
    data class Sent(val message: String) : InputStatus
    data class Failed(val message: String) : InputStatus
}

// ---------------------------------------------------------------------
// ViewModel
// ---------------------------------------------------------------------

class AppViewModel(app: Application) : AndroidViewModel(app), RelayClient.Listener {

    private val prefs = app.getSharedPreferences("cmux_remote", Context.MODE_PRIVATE)
    private val client = RelayClient(viewModelScope)

    // ---- persisted settings ----
    var mode by mutableStateOf(ConnectionMode.DIRECT)
    var host by mutableStateOf("")
    var port by mutableStateOf(4399)
    var scheme by mutableStateOf("http")
    var brokerUrl by mutableStateOf("")
    var relayId by mutableStateOf("")
    var pairingCode by mutableStateOf("")
    val clientId: String
    val deviceName: String = android.os.Build.MODEL ?: "Android"

    // ---- live state ----
    var connectionState by mutableStateOf(ConnectionState.DISCONNECTED)
        private set
    var connectionError by mutableStateOf<String?>(null)
        private set
    var reconnecting by mutableStateOf(false)
        private set
    var transportLabel by mutableStateOf<String?>(null)
        private set

    var windows by mutableStateOf<List<CmuxWindow>>(emptyList())
        private set
    var selectedWindowId by mutableStateOf<String?>(null)
        private set
    var workspaces by mutableStateOf<List<Workspace>>(emptyList())
        private set
    var surfacesByWorkspace by mutableStateOf<Map<String, List<Surface>>>(emptyMap())
        private set
    var selectedWorkspaceId by mutableStateOf<String?>(null)
        private set

    var frame by mutableStateOf(TerminalFrame())
        private set
    var subscribedSurfaceId by mutableStateOf<String?>(null)
        private set
    var subscribedWorkspaceId by mutableStateOf<String?>(null)
        private set
    var historyRows by mutableStateOf<List<String>>(emptyList())
        private set
    var historyNextCursor by mutableStateOf<String?>(null)
        private set
    var historyLoading by mutableStateOf(false)
        private set

    var inputStatus by mutableStateOf<InputStatus>(InputStatus.Idle)
        private set
    var battery by mutableStateOf(HostBattery())
        private set
    val inbox = mutableStateListOf<InboxItem>()
    var unreadInbox by mutableStateOf(0)
        private set
    var unreadByWorkspace by mutableStateOf<Map<String, Int>>(emptyMap())
        private set
    var liveInputMode by mutableStateOf(false)

    // ---- persisted terminal preferences (iOS AppStorage equivalents) ----
    var defaultLiveInput by mutableStateOf(false)
    var showShortcutBar by mutableStateOf(true)
    var keepKeyboardAfterSubmit by mutableStateOf(false)

    /** Surface requested by an inbox tap; consumed by the terminal view. */
    var preferredSurfaceId by mutableStateOf<String?>(null)

    /** Bumps on every pushed terminal frame so the view can auto-scroll. */
    var frameTick by mutableStateOf(0L)
        private set

    var onNotification: ((InboxItem) -> Unit)? = null
    private val screen = ScreenState()
    private var seenInboxIds = HashSet<String>()
    private var connectGeneration = 0
    private var authRetryUsed = false

    val endpoint: RelayEndpoint
        get() = if (mode == ConnectionMode.DIRECT)
            RelayEndpoint(mode = mode, host = host, port = port, scheme = scheme)
        else
            RelayEndpoint(mode = mode, brokerBaseUrl = brokerUrl, relayId = relayId)

    /** Name shown in the computer switcher, like iOS `computers.selected?.name`. */
    val computerName: String
        get() = when (mode) {
            ConnectionMode.BROKER -> relayId.ifBlank { "server" }
            ConnectionMode.DIRECT -> host.ifBlank { "direct" }
        }

    /** Enough endpoint config to attempt a connection without the pairing screen. */
    val hasEndpointConfig: Boolean
        get() = endpoint.validate() == null &&
            (mode == ConnectionMode.DIRECT || storedCredentials(endpoint.credentialKey()) != null ||
                pairingCode.isNotBlank())

    init {
        client.listener = this
        val debugFile = java.io.File(app.filesDir, "relay_debug.log")
        client.debug = { msg ->
            try {
                debugFile.appendText(
                    java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.US)
                        .format(java.util.Date()) + " " + msg + "\n")
            } catch (_: Exception) {}
        }
        loadSettings()
        clientId = prefs.getString("client_id", null) ?: UUID.randomUUID().toString().also {
            prefs.edit().putString("client_id", it).apply()
        }
    }

    // --------------------------------------------------------------
    // Settings persistence
    // --------------------------------------------------------------

    private fun loadSettings() {
        mode = if (prefs.getString("mode", "direct") == "broker") ConnectionMode.BROKER else ConnectionMode.DIRECT
        host = prefs.getString("host", "") ?: ""
        port = prefs.getInt("port", 4399)
        scheme = prefs.getString("scheme", "http") ?: "http"
        brokerUrl = prefs.getString("broker_url", "") ?: ""
        relayId = prefs.getString("relay_id", "") ?: ""
        pairingCode = prefs.getString("pairing_code", "") ?: ""
        defaultLiveInput = prefs.getBoolean("default_live_input", false)
        showShortcutBar = prefs.getBoolean("show_shortcut_bar", true)
        keepKeyboardAfterSubmit = prefs.getBoolean("keep_keyboard", false)
        liveInputMode = defaultLiveInput
    }

    fun saveSettings() {
        prefs.edit()
            .putString("mode", if (mode == ConnectionMode.BROKER) "broker" else "direct")
            .putString("host", host)
            .putInt("port", port)
            .putString("scheme", scheme)
            .putString("broker_url", brokerUrl)
            .putString("relay_id", relayId)
            .putString("pairing_code", pairingCode)
            .putBoolean("default_live_input", defaultLiveInput)
            .putBoolean("show_shortcut_bar", showShortcutBar)
            .putBoolean("keep_keyboard", keepKeyboardAfterSubmit)
            .apply()
    }

    /** Drop credentials, endpoint config, and pairing — back to the scan screen. */
    fun forgetComputer() {
        disconnect()
        prefs.edit()
            .remove("cred|${endpoint.credentialKey()}")
            .remove("host").remove("port").remove("scheme")
            .remove("broker_url").remove("relay_id").remove("pairing_code")
            .remove("mode")
            .apply()
        host = ""
        port = 4399
        scheme = "http"
        brokerUrl = ""
        relayId = ""
        pairingCode = ""
        inbox.clear()
        unreadInbox = 0
        unreadByWorkspace = emptyMap()
        seenInboxIds.clear()
    }

    fun applyPairingLink(raw: String): Boolean {
        dbg("applyPairingLink raw=$raw")
        val payload = PairingPayload.parse(raw) ?: run {
            dbg("applyPairingLink parse=null")
            return false
        }
        if (!payload.lanUrl.isNullOrEmpty() && !payload.lanPairingCode.isNullOrEmpty()) {
            PairingPayload.lanEndpoint(payload.lanUrl)?.let { ep ->
                mode = ConnectionMode.DIRECT
                host = ep.host
                port = ep.port
                scheme = ep.scheme
                pairingCode = payload.lanPairingCode
                saveSettings()
                return true
            }
        }
        mode = ConnectionMode.BROKER
        brokerUrl = payload.serverUrl
        relayId = payload.relayId
        pairingCode = payload.pairingCode
        saveSettings()
        return true
    }

    // --------------------------------------------------------------
    // Credentials
    // --------------------------------------------------------------

    private fun storedCredentials(key: String): DeviceCredentials? {
        val raw = prefs.getString("cred|$key", null) ?: return null
        return try {
            val j = JSONObject(raw)
            DeviceCredentials(j.getString("device_id"), j.getString("token"))
        } catch (_: Exception) {
            null
        }
    }

    private fun storeCredentials(key: String, c: DeviceCredentials) {
        val j = JSONObject().put("device_id", c.deviceId).put("token", c.token)
        prefs.edit().putString("cred|$key", j.toString()).apply()
    }

    fun forgetCredentials() {
        prefs.edit().remove("cred|${endpoint.credentialKey()}").apply()
    }

    // --------------------------------------------------------------
    // Connect / disconnect
    // --------------------------------------------------------------

    fun dbg(msg: String) {
        try {
            java.io.File(getApplication<Application>().filesDir, "relay_debug.log")
                .appendText(
                    java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.US)
                        .format(java.util.Date()) + " vm: " + msg + "\n")
        } catch (_: Exception) {}
    }

    fun connect() {
        val ep = endpoint
        dbg("connect ep=${ep.credentialKey()}")
        ep.validate()?.let {
            dbg("connect validate failed: $it")
            connectionState = ConnectionState.ERROR
            connectionError = it
            return
        }
        saveSettings()
        val generation = ++connectGeneration
        connectionState = ConnectionState.CONNECTING
        connectionError = null
        transportLabel = ep.transportLabel

        viewModelScope.launch {
            try {
                val key = ep.credentialKey()
                val creds = storedCredentials(key) ?: run {
                    if (ep.requiresPairingCode && pairingCode.isBlank())
                        throw RpcException("missing_pairing_code", "Pairing code is required")
                    client.register(ep, pairingCode.trim(), clientId, deviceName)
                        .also { storeCredentials(key, it) }
                }
                if (generation != connectGeneration) return@launch
                val version = appVersion()
                client.connect(ep, creds, version)
            } catch (e: RelayHttpException) {
                // A stored bearer that the relay no longer recognizes should
                // force re-pairing rather than looping on 401/403 forever.
                if (e.status == 401 || e.status == 403) forgetCredentials()
                failConnect(e)
            } catch (e: Exception) {
                android.util.Log.w("AppViewModel", "connect failed", e)
                try {
                    java.io.File(getApplication<Application>().filesDir, "relay_debug.log")
                        .appendText("connect failed: $e\n")
                } catch (_: Exception) {}
                failConnect(e)
            }
        }
    }

    private fun appVersion(): String = try {
        getApplication<Application>().packageManager
            .getPackageInfo(getApplication<Application>().packageName, 0).versionName ?: "1.0.0"
    } catch (_: Exception) {
        "1.0.0"
    }

    private fun failConnect(e: Exception) {
        connectionState = ConnectionState.ERROR
        connectionError = e.message ?: e.toString()
    }

    fun disconnect() {
        connectGeneration++
        client.disconnect()
        resetSessionState()
        connectionState = ConnectionState.DISCONNECTED
    }

    private fun resetSessionState() {
        windows = emptyList()
        workspaces = emptyList()
        surfacesByWorkspace = emptyMap()
        selectedWindowId = null
        selectedWorkspaceId = null
        subscribedSurfaceId = null
        subscribedWorkspaceId = null
        screen.reset()
        frame = TerminalFrame()
        historyRows = emptyList()
        historyNextCursor = null
        battery = HostBattery()
        reconnecting = false
    }

    // --------------------------------------------------------------
    // RelayClient.Listener (OkHttp threads → viewModelScope)
    // --------------------------------------------------------------

    override fun onOpen() {
        viewModelScope.launch {
            reconnecting = false
            authRetryUsed = false
            connectionState = ConnectionState.CONNECTED
            connectionError = null
            // Re-subscribe after a reconnect, then refresh everything.
            subscribedWorkspaceId?.let { ws ->
                subscribedSurfaceId?.let { sf -> doSubscribe(ws, sf) }
            }
            refresh()
            refreshBattery()
        }
    }

    override fun onPush(push: PushFrame) {
        viewModelScope.launch {
            when (push) {
                is PushFrame.ScreenFull -> {
                    if (push.surfaceId == subscribedSurfaceId || subscribedSurfaceId == null) {
                        screen.applyFull(push)
                        publishFrame()
                    }
                }
                is PushFrame.ScreenDiff -> {
                    if (push.surfaceId == subscribedSurfaceId || subscribedSurfaceId == null) {
                        screen.applyDiff(push)
                        publishFrame()
                    }
                }
                is PushFrame.ScreenChecksum -> {
                    if (push.surfaceId == subscribedSurfaceId && !screen.checksumMatches(push.hash)) {
                        requestFull(push.surfaceId)
                    }
                }
                is PushFrame.Event -> ingestEvent(push)
                else -> Unit
            }
        }
    }

    override fun onClosed(reconnecting: Boolean) {
        viewModelScope.launch {
            this@AppViewModel.reconnecting = reconnecting
            if (!reconnecting) {
                connectionState = ConnectionState.DISCONNECTED
            }
        }
    }

    override fun onAuthFailed() {
        viewModelScope.launch {
            // The stored bearer no longer validates (e.g. re-registration
            // replaced the token, or the relay's device store was reset).
            // Drop it and re-register once; a fresh token that is still
            // rejected means the pairing itself is wrong.
            forgetCredentials()
            if (!authRetryUsed) {
                authRetryUsed = true
                reconnecting = false
                connect()
            } else {
                authRetryUsed = false
                reconnecting = false
                connectionState = ConnectionState.ERROR
                connectionError = "Pairing rejected by relay — scan the QR code again"
            }
        }
    }

    private fun publishFrame() {
        frame = TerminalFrame(screen.rows, screen.cols, screen.rev, screen.cursorX, screen.cursorY)
        frameTick++
    }

    // --------------------------------------------------------------
    // Workspace / surface actions
    // --------------------------------------------------------------

    fun refresh() {
        viewModelScope.launch {
            try {
                refreshWindows()
                val params = mutableMapOf<String, Any?>()
                selectedWindowId?.let { params["window_id"] = it }
                val result = client.call("workspace.list", rpcParams(*params.toList().toTypedArray()))
                val list = (result as? JSONObject)?.optJSONArray("workspaces")
                val loaded = mutableListOf<Workspace>()
                if (list != null) {
                    for (i in 0 until list.length()) {
                        val w = list.optJSONObject(i) ?: continue
                        val id = w.optStringOrNull("id")
                            ?: w.optStringOrNull("workspace_id") ?: continue
                        loaded.add(
                            Workspace(
                                id = id,
                                name = w.optStringOrNull("title") ?: w.optStringOrNull("name") ?: id,
                                index = w.optInt("index", i),
                            )
                        )
                        maybeWorkspaceAlert(w)
                    }
                }
                workspaces = loaded.sortedBy { it.index }
                if (selectedWorkspaceId == null || loaded.none { it.id == selectedWorkspaceId }) {
                    selectedWorkspaceId = loaded.firstOrNull()?.id
                }
                for (w in loaded) refreshSurfaces(w.id)
            } catch (_: Exception) {
            }
        }
    }

    private suspend fun refreshWindows() {
        try {
            val result = client.call("window.list")
            val arr = (result as? JSONObject)?.optJSONArray("windows")
            val list = mutableListOf<CmuxWindow>()
            if (arr != null) {
                for (i in 0 until arr.length()) {
                    val w = arr.optJSONObject(i) ?: continue
                    val id = w.optStringOrNull("id") ?: continue
                    list.add(
                        CmuxWindow(
                            id = id,
                            ref = w.optStringOrNull("ref") ?: id,
                            index = w.optInt("index", i),
                            workspaceCount = w.optInt("workspaceCount", w.optInt("workspace_count", 0)),
                            isKey = w.optBoolean("key", false),
                        )
                    )
                }
            }
            windows = list.sortedBy { it.index }
        } catch (_: Exception) {
            windows = emptyList()
        }
        if (windows.isEmpty()) {
            selectedWindowId = null
            return
        }
        if (selectedWindowId == null || windows.none { it.id == selectedWindowId }) {
            selectedWindowId = (windows.firstOrNull { it.isKey } ?: windows.first()).id
        }
    }

    fun selectWindow(id: String) {
        if (selectedWindowId == id) return
        selectedWindowId = id
        selectedWorkspaceId = null
        workspaces = emptyList()
        surfacesByWorkspace = emptyMap()
        refresh()
    }

    fun refreshSurfaces(workspaceId: String) {
        viewModelScope.launch {
            try {
                val result = client.call("surface.list", rpcParams("workspace_id" to workspaceId))
                val arr = (result as? JSONObject)?.optJSONArray("surfaces")
                val list = mutableListOf<Surface>()
                if (arr != null) {
                    for (i in 0 until arr.length()) {
                        val s = arr.optJSONObject(i) ?: continue
                        val id = s.optStringOrNull("id") ?: continue
                        list.add(Surface(id, s.optStringOrNull("title") ?: id, s.optInt("index", i)))
                    }
                }
                surfacesByWorkspace = surfacesByWorkspace + (workspaceId to list.sortedBy { it.index })
            } catch (_: Exception) {
            }
        }
    }

    fun selectWorkspace(id: String) {
        if (selectedWorkspaceId != id) {
            selectedWorkspaceId = id
            client.callAsync("workspace.select", rpcParams("workspace_id" to id))
        }
    }

    fun createWorkspace(name: String) = runRpc {
        client.call(
            "workspace.create",
            rpcParams(
                "title" to name,
                "window_id" to selectedWindowId,
            )
        )
        refresh()
    }

    fun renameWorkspace(id: String, title: String) = runRpc {
        client.call("workspace.rename", rpcParams("workspace_id" to id, "title" to title))
        refresh()
    }

    fun closeWorkspace(id: String) = runRpc {
        client.call("workspace.close", rpcParams("workspace_id" to id))
        if (selectedWorkspaceId == id) selectedWorkspaceId = null
        refresh()
    }

    fun createSurface(workspaceId: String, onCreated: (String) -> Unit = {}) = runRpc {
        val result = client.call(
            "surface.create",
            rpcParams("workspace_id" to workspaceId, "type" to "terminal", "focus" to true)
        )
        refreshSurfaces(workspaceId)
        val obj = result as? JSONObject
        val id = obj?.optStringOrNull("surface_id") ?: obj?.optStringOrNull("id")
        if (id != null) onCreated(id)
    }

    fun closeSurface(workspaceId: String, surfaceId: String) = runRpc {
        if (subscribedSurfaceId == surfaceId) unsubscribe()
        client.call("surface.close", rpcParams("workspace_id" to workspaceId, "surface_id" to surfaceId))
        refreshSurfaces(workspaceId)
    }

    // --------------------------------------------------------------
    // Terminal subscription + input
    // --------------------------------------------------------------

    fun openSurface(workspaceId: String, surfaceId: String) {
        viewModelScope.launch {
            if (subscribedSurfaceId != null && subscribedSurfaceId != surfaceId) {
                unsubscribe()
            }
            screen.reset()
            historyRows = emptyList()
            historyNextCursor = null
            publishFrame()
            subscribedSurfaceId = surfaceId
            subscribedWorkspaceId = workspaceId
            doSubscribe(workspaceId, surfaceId)
        }
    }

    private suspend fun doSubscribe(workspaceId: String, surfaceId: String) {
        try {
            client.call(
                "surface.subscribe",
                rpcParams(
                    "workspace_id" to workspaceId,
                    "surface_id" to surfaceId,
                    "fps" to 15,
                    "lines" to 400,
                )
            )
        } catch (_: Exception) {
        }
        try {
            client.call("surface.focus", rpcParams("workspace_id" to workspaceId, "surface_id" to surfaceId))
        } catch (_: Exception) {
        }
        requestFull(surfaceId)
    }

    private fun requestFull(surfaceId: String) {
        viewModelScope.launch {
            val ws = subscribedWorkspaceId ?: return@launch
            try {
                val result = client.call(
                    "surface.read_text",
                    rpcParams(
                        "workspace_id" to ws,
                        "surface_id" to surfaceId,
                        "lines" to 400,
                    )
                )
                val text = (result as? JSONObject)?.optStringOrNull("text") ?: return@launch
                screen.setFromText(text, screen.rev + 1)
                publishFrame()
            } catch (_: Exception) {
            }
        }
    }

    fun unsubscribe() {
        val sf = subscribedSurfaceId ?: return
        client.callAsync("surface.unsubscribe", rpcParams("surface_id" to sf))
        subscribedSurfaceId = null
        subscribedWorkspaceId = null
    }

    fun loadOlderHistory() {
        val ws = subscribedWorkspaceId ?: return
        val sf = subscribedSurfaceId ?: return
        if (historyLoading) return
        if (historyRows.isNotEmpty() && historyNextCursor == null) return
        historyLoading = true
        viewModelScope.launch {
            try {
                val result = client.call(
                    "surface.history",
                    rpcParams(
                        "workspace_id" to ws,
                        "surface_id" to sf,
                        "cursor" to historyNextCursor,
                        "tail_lines" to 400,
                        "limit" to 200,
                    )
                )
                val obj = result as? JSONObject ?: return@launch
                val arr = obj.optJSONArray("rows")
                val page = if (arr != null) (0 until arr.length()).map { arr.optString(it, "") } else emptyList()
                historyRows = page + historyRows
                historyNextCursor = obj.optStringOrNull("next_cursor")
            } catch (_: Exception) {
            } finally {
                historyLoading = false
            }
        }
    }

    fun sendText(text: String) {
        val ws = subscribedWorkspaceId ?: return
        val sf = subscribedSurfaceId ?: return
        dispatchInput("sent text") {
            client.call(
                "surface.send_text",
                rpcParams("workspace_id" to ws, "surface_id" to sf, "text" to text)
            )
        }
    }

    fun sendKey(key: String) {
        val ws = subscribedWorkspaceId ?: return
        val sf = subscribedSurfaceId ?: return
        dispatchInput("sent $key") {
            try {
                client.call("surface.focus", rpcParams("workspace_id" to ws, "surface_id" to sf))
            } catch (_: Exception) {
            }
            client.call(
                "surface.send_key",
                rpcParams("workspace_id" to ws, "surface_id" to sf, "key" to key)
            )
        }
    }

    fun submitCommand(command: String) {
        val trimmed = command.trim()
        if (trimmed.isEmpty()) {
            sendKey("enter")
            return
        }
        val ws = subscribedWorkspaceId ?: return
        val sf = subscribedSurfaceId ?: return
        dispatchInput("sent $trimmed") {
            client.call(
                "surface.send_text",
                rpcParams("workspace_id" to ws, "surface_id" to sf, "text" to trimmed)
            )
            client.call(
                "surface.send_key",
                rpcParams("workspace_id" to ws, "surface_id" to sf, "key" to "enter")
            )
        }
    }

    /** Sticky ctrl + character → cmux key name like `ctrl-c`. */
    fun sendCtrlCombo(letter: Char) = sendKey("ctrl-${letter.lowercaseChar()}")

    fun refreshBattery() {
        viewModelScope.launch {
            try {
                val result = client.call("host.battery")
                val obj = result as? JSONObject
                battery = if (obj != null) HostBattery(
                    available = obj.optBoolean("available", false),
                    percent = if (obj.has("percent") && !obj.isNull("percent")) obj.optInt("percent") else null,
                    isCharging = obj.optBoolean("is_charging", obj.optBoolean("isCharging", false)),
                    powerSource = obj.optStringOrNull("power_source") ?: obj.optStringOrNull("powerSource"),
                ) else HostBattery()
            } catch (_: Exception) {
            }
        }
    }

    fun markInboxRead() {
        unreadInbox = 0
        unreadByWorkspace = emptyMap()
    }

    /** iOS `notifStore.markWorkspaceSeen` — clears one workspace's badge. */
    fun markWorkspaceSeen(workspaceId: String) {
        val next = unreadByWorkspace - workspaceId
        if (next.size != unreadByWorkspace.size) {
            unreadByWorkspace = next
            unreadInbox = next.values.sum()
        }
    }

    /**
     * iOS ContentView.open(notification:): jump to the workspace/surface an
     * inbox item points at. Returns true when the workspace is known.
     */
    fun openInboxItem(item: InboxItem): Boolean {
        return if (workspaces.any { it.id == item.workspaceId }) {
            selectWorkspace(item.workspaceId)
            preferredSurfaceId = item.surfaceId
            markWorkspaceSeen(item.workspaceId)
            true
        } else {
            preferredSurfaceId = null
            false
        }
    }

    private fun bumpUnread(workspaceId: String) {
        unreadInbox++
        unreadByWorkspace = unreadByWorkspace + (workspaceId to ((unreadByWorkspace[workspaceId] ?: 0) + 1))
    }

    // --------------------------------------------------------------
    // Events → inbox (port of iOS InboxNotification heuristics)
    // --------------------------------------------------------------

    private fun ingestEvent(event: PushFrame.Event) {
        val record = inboxRecord(event) ?: return
        if (!seenInboxIds.add(record.id)) return
        inbox.add(0, record)
        bumpUnread(record.workspaceId)
        onNotification?.invoke(record)
    }

    private fun inboxRecord(event: PushFrame.Event): InboxItem? {
        val payload = event.payload
        val leaves = payload?.stringLeaves() ?: emptyList()
        val searchText = (listOf(event.category, event.name) +
            listOfNotNull(
                payload?.optStringOrNull("app"), payload?.optStringOrNull("source"),
                payload?.optStringOrNull("title"), payload?.optStringOrNull("body"),
                payload?.optStringOrNull("message"), payload?.optStringOrNull("status"),
            ) + leaves)
            .joinToString(" ")
            .lowercase()
            .replace('_', ' ')
            .replace('-', ' ')

        val needsHuman = searchText.contains("needs input") ||
            searchText.contains("waiting for your input") ||
            searchText.contains("needs your attention") ||
            searchText.contains("needs your approval") ||
            searchText.contains("approval required") ||
            searchText.contains("permission prompt")
        val knownSource = searchText.contains("claude") || searchText.contains("codex") ||
            searchText.contains("openai")
        val directNeedsInput = event.name.lowercase().replace('_', ' ').replace('-', ' ')
            .contains("needs input") || searchText.contains("needs input")
        val isNeedsInput = needsHuman && (knownSource || directNeedsInput)
        val isNotification = event.category == "notification" || event.name == "notification.created"
        if (!isNotification && !isNeedsInput) return null

        val workspaceId = payload?.optStringOrNull("workspace_id")
            ?: payload?.optStringOrNull("workspaceId") ?: "unknown"
        val surfaceId = payload?.optStringOrNull("surface_id") ?: payload?.optStringOrNull("surfaceId")
        val source = when {
            searchText.contains("codex") -> "Codex"
            searchText.contains("openai") -> "OpenAI"
            searchText.contains("claude") -> "Claude Code"
            event.category == "hook" -> "cmux hook"
            event.category == "agent" -> "Agent"
            else -> "cmux"
        }
        val title = payload?.optStringOrNull("title") ?: payload?.optStringOrNull("headline")
            ?: if (isNeedsInput) "$source needs input" else event.name
        val body = payload?.optStringOrNull("body") ?: payload?.optStringOrNull("message")
            ?: payload?.optStringOrNull("text") ?: payload?.optStringOrNull("summary")
            ?: title
        val id = payload?.optStringOrNull("id") ?: payload?.optStringOrNull("notification_id")
            ?: "evt-${event.name}-${workspaceId}-${title.hashCode()}-${body.hashCode()}"
        return InboxItem(
            id = id,
            workspaceId = workspaceId,
            surfaceId = surfaceId,
            title = title,
            subtitle = payload?.optStringOrNull("subtitle")
                ?: payload?.optStringOrNull("workspace_title"),
            body = body,
            ts = payload?.optLong("ts")?.takeIf { it > 0 } ?: System.currentTimeMillis() / 1000,
            requiresInput = isNeedsInput,
        )
    }

    /** needs-input detection on workspace.list payloads, like iOS publishWorkspaceAlerts. */
    private fun maybeWorkspaceAlert(w: JSONObject) {
        val leaves = w.stringLeaves()
        val candidates = listOfNotNull(
            w.optStringOrNull("status"), w.optStringOrNull("state"), w.optStringOrNull("reason"),
            w.optStringOrNull("message"), w.optStringOrNull("body"), w.optStringOrNull("summary"),
            w.optStringOrNull("agent_status"), w.optStringOrNull("last_message"),
        ) + leaves
        val normalized = { s: String -> s.lowercase().replace('_', ' ').replace('-', ' ') }
        val body = candidates.firstOrNull { v ->
            val t = normalized(v)
            (t.contains("needs input") || t.contains("waiting for your input") ||
                t.contains("needs your attention") || t.contains("approval required")) &&
                (t.contains("claude") || t.contains("codex") || t.contains("openai") ||
                    leaves.joinToString(" ") { normalized(it) }.let {
                        it.contains("claude") || it.contains("codex") || it.contains("openai")
                    })
        } ?: return

        val id = w.optStringOrNull("id") ?: w.optStringOrNull("workspace_id") ?: return
        val allText = (candidates + w.optString("title") + w.optString("name"))
            .joinToString(" ") { normalized(it) }
        val source = when {
            allText.contains("codex") -> "Codex"
            allText.contains("openai") -> "OpenAI"
            allText.contains("claude") -> "Claude Code"
            else -> "Agent"
        }
        val alertId = "ws-alert-$id-${body.hashCode()}"
        if (!seenInboxIds.add(alertId)) return
        val item = InboxItem(
            id = alertId,
            workspaceId = id,
            surfaceId = w.optStringOrNull("active_surface_id") ?: w.optStringOrNull("surface_id"),
            title = "$source needs input",
            subtitle = w.optStringOrNull("title") ?: w.optStringOrNull("name"),
            body = body,
            ts = System.currentTimeMillis() / 1000,
            requiresInput = true,
        )
        inbox.add(0, item)
        bumpUnread(item.workspaceId)
        onNotification?.invoke(item)
    }

    // --------------------------------------------------------------
    // Helpers
    // --------------------------------------------------------------

    private fun dispatchInput(successMessage: String, op: suspend () -> Any?) {
        inputStatus = InputStatus.Sending
        viewModelScope.launch {
            try {
                op()
                inputStatus = InputStatus.Sent(successMessage)
            } catch (e: Exception) {
                inputStatus = InputStatus.Failed(e.message ?: "send failed")
            }
        }
    }

    private fun runRpc(op: suspend () -> Unit) {
        viewModelScope.launch {
            try {
                op()
            } catch (e: Exception) {
                inputStatus = InputStatus.Failed(e.message ?: "failed")
            }
        }
    }

    fun surfacesFor(workspaceId: String): List<Surface> = surfacesByWorkspace[workspaceId] ?: emptyList()

    override fun onCleared() {
        client.listener = null
        client.disconnect()
    }
}
