package com.genie.cmuxremote.net

import android.util.Log
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

/** Bearer + device id issued by the relay's register endpoint. */
data class DeviceCredentials(val deviceId: String, val token: String)

/**
 * Talks to cmux-relay: HTTP for pairing, one WebSocket for the RPC channel.
 *
 * Protocol (mirrors the iOS client):
 *  - WS upgrade carries `Authorization: Bearer <token>` and
 *    `Sec-WebSocket-Protocol: cmuxremote.v1`.
 *  - First client frame must be a hello within the relay's 100ms window:
 *    `{"deviceId":…,"appVersion":…,"protocolVersion":1}` (camelCase keys).
 *  - RPC frames are `{"id","method","params"}`; replies carry the same `id`.
 *  - Server pushes `screen.full` / `screen.diff` / `screen.checksum` /
 *    `event` / `ping` frames with no `id`.
 */
class RelayClient(private val scope: CoroutineScope) {

    interface Listener {
        fun onOpen()
        fun onPush(frame: PushFrame)
        /** Closed or failed. The client may still be auto-reconnecting. */
        fun onClosed(reconnecting: Boolean)
        /** WS upgrade rejected (401/403/404) — the stored token is stale. */
        fun onAuthFailed()
    }

    var listener: Listener? = null

    /** Optional debug sink (file logger — vivo devices suppress logcat). */
    var debug: ((String) -> Unit)? = null
    private fun dbg(msg: String) { try { debug?.invoke(msg) } catch (_: Exception) {} }

    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)   // WS: no read timeout
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private val httpShort = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    @Volatile private var ws: WebSocket? = null
    @Volatile private var wsGeneration = 0
    @Volatile private var shouldReconnect = false
    private var reconnectAttempts = 0

    private var connectParams: ConnectParams? = null

    private val pending = ConcurrentHashMap<String, CompletableDeferred<RpcResult>>()

    private data class ConnectParams(
        val wsUrl: String,
        val token: String,
        val deviceId: String,
        val appVersion: String,
    )

    // ------------------------------------------------------------------
    // HTTP
    // ------------------------------------------------------------------

    suspend fun health(endpoint: RelayEndpoint): Boolean = withContext(Dispatchers.IO) {
        try {
            httpShort.newCall(Request.Builder().url(endpoint.healthUrl()).get().build())
                .execute().use { it.isSuccessful }
        } catch (_: Exception) {
            false
        }
    }

    /**
     * POST /v1/devices/me/register.
     * LAN/broker send `{pairing_code, client_id, device_name}` (+ `relay_id`
     * for the broker); a tailnet host posts an empty body and the relay
     * resolves identity via tailscaled whois.
     */
    suspend fun register(
        endpoint: RelayEndpoint,
        pairingCode: String,
        clientId: String,
        deviceName: String,
    ): DeviceCredentials = withContext(Dispatchers.IO) {
        val bodyJson = JSONObject()
        if (endpoint.requiresPairingCode) {
            if (endpoint.mode == ConnectionMode.BROKER) {
                bodyJson.put("relay_id", endpoint.relayId.trim())
            }
            bodyJson.put("pairing_code", pairingCode)
            bodyJson.put("client_id", clientId)
            bodyJson.put("device_name", deviceName)
        }
        val request = Request.Builder()
            .url(endpoint.registerUrl())
            .post(bodyJson.toString().toRequestBody("application/json".toMediaType()))
            .build()
        httpShort.newCall(request).execute().use { resp ->
            if (resp.code != 200) throw RelayHttpException(resp.code)
            val body = resp.body?.string() ?: throw RelayHttpException(resp.code)
            val json = JSONObject(body)
            DeviceCredentials(
                deviceId = json.getString("device_id"),
                token = json.getString("token"),
            )
        }
    }

    // ------------------------------------------------------------------
    // WebSocket
    // ------------------------------------------------------------------

    fun connect(endpoint: RelayEndpoint, credentials: DeviceCredentials, appVersion: String) {
        disconnect()
        shouldReconnect = true
        reconnectAttempts = 0
        connectParams = ConnectParams(
            wsUrl = endpoint.webSocketUrl(),
            token = credentials.token,
            deviceId = credentials.deviceId,
            appVersion = appVersion,
        )
        openSocket()
    }

    private fun openSocket() {
        val params = connectParams ?: return
        val generation = ++wsGeneration
        val request = Request.Builder()
            .url(params.wsUrl)
            .header("Authorization", "Bearer ${params.token}")
            .header("Sec-WebSocket-Protocol", "cmuxremote.v1")
            .build()
        Log.d("RelayClient", "openSocket ${params.wsUrl} gen=$generation")
        dbg("openSocket ${params.wsUrl} gen=$generation")
        val socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.d("RelayClient", "onOpen gen=$generation")
                dbg("onOpen gen=$generation")
                reconnectAttempts = 0
                val hello = JSONObject()
                    .put("deviceId", params.deviceId)
                    .put("appVersion", params.appVersion)
                    .put("protocolVersion", 1)
                    .toString()
                webSocket.send(hello)
                listener?.onOpen()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleText(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.d("RelayClient", "onClosed code=$code reason=$reason gen=$generation cur=$wsGeneration")
                dbg("onClosed code=$code reason=$reason gen=$generation cur=$wsGeneration")
                if (wsGeneration == generation) socketClosed()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w("RelayClient", "onFailure gen=$generation cur=$wsGeneration http=${response?.code} err=${t.message}")
                dbg("onFailure gen=$generation cur=$wsGeneration http=${response?.code} err=$t")
                if (wsGeneration != generation) return
                val code = response?.code
                if (code == 401 || code == 403 || code == 404) {
                    // Upgrade rejected — the bearer token no longer validates.
                    // Surface this separately so the caller can re-register
                    // instead of retrying a dead token forever.
                    shouldReconnect = false
                    ws = null
                    failAllPending(RpcException("auth", "token rejected"))
                    listener?.onAuthFailed()
                    return
                }
                socketClosed()
            }
        })
        ws = socket
    }

    private fun socketClosed() {
        dbg("socketClosed shouldReconnect=$shouldReconnect attempts=$reconnectAttempts")
        ws = null
        failAllPending(RpcException("closed", "connection closed"))
        if (shouldReconnect) {
            listener?.onClosed(reconnecting = true)
            val delayMs = minOf(1000L shl reconnectAttempts.coerceAtMost(5), 30_000L)
            reconnectAttempts++
            scope.launch {
                delay(delayMs)
                if (shouldReconnect) openSocket()
            }
        } else {
            listener?.onClosed(reconnecting = false)
        }
    }

    fun disconnect() {
        shouldReconnect = false
        connectParams = null
        wsGeneration++
        ws?.close(1000, null)
        ws = null
        failAllPending(RpcException("closed", "disconnected"))
    }

    // ------------------------------------------------------------------
    // RPC
    // ------------------------------------------------------------------

    suspend fun call(method: String, params: JSONObject = JSONObject(), timeoutMs: Long = 10_000): Any? {
        val socket = ws ?: throw RpcException("closed", "not connected")
        val id = UUID.randomUUID().toString()
        val deferred = CompletableDeferred<RpcResult>()
        pending[id] = deferred
        val frame = JSONObject()
            .put("id", id)
            .put("method", method)
            .put("params", params)
            .toString()
        if (!socket.send(frame)) {
            pending.remove(id)
            throw RpcException("send_failed", "websocket send failed")
        }
        val result = try {
            withTimeout(timeoutMs) { deferred.await() }
        } catch (e: Exception) {
            pending.remove(id)
            if (e is RpcException) throw e
            throw RpcException("timeout", "RPC $method timed out")
        }
        if (!result.ok) {
            throw RpcException(result.errorCode ?: "error", result.errorMessage ?: "RPC $method failed")
        }
        return result.result
    }

    /** Fire-and-forget variant used for calls where the ack doesn't matter. */
    fun callAsync(method: String, params: JSONObject = JSONObject()) {
        scope.launch { runCatching { call(method, params) } }
    }

    private fun handleText(text: String) {
        val json = try { JSONObject(text) } catch (_: Exception) { return }
        val id = json.optStringOrNull("id")
        if (id != null) {
            val deferred = pending.remove(id)
            if (deferred != null) {
                val error = json.optJSONObject("error")
                val ok = json.optBoolean("ok", true) && error == null
                deferred.complete(
                    RpcResult(
                        ok = ok,
                        result = json.opt("result"),
                        errorCode = error?.optString("code"),
                        errorMessage = error?.optString("message"),
                    )
                )
                return
            }
        }
        PushFrame.parse(text)?.let { listener?.onPush(it) }
    }

    private fun failAllPending(e: RpcException) {
        for ((_, d) in pending) {
            d.complete(RpcResult(ok = false, result = null, errorCode = e.code, errorMessage = e.message))
        }
        pending.clear()
    }
}

class RelayHttpException(val status: Int) : Exception("relay rejected the request (HTTP $status)")
