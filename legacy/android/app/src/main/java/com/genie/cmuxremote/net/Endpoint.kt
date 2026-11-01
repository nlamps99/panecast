package com.genie.cmuxremote.net

import android.net.Uri
import java.net.URL
import java.util.Locale

/** Connection transport. Mirrors iOS `ConnectionMode`. */
enum class ConnectionMode(val label: String) {
    DIRECT("Direct"),
    BROKER("Server"),
}

/**
 * Where the app should reach the relay. Mirrors iOS `RelayEndpoint`.
 *
 * Direct: plain http(s)://host:port against cmux-relay on the Mac
 * (Tailscale tailnet host or a private-LAN address).
 * Broker: https base URL of the self-hosted VPS broker + relay id.
 */
data class RelayEndpoint(
    val mode: ConnectionMode = ConnectionMode.DIRECT,
    val host: String = "",
    val port: Int = 4399,
    val scheme: String = "http",
    val brokerBaseUrl: String = "",
    val relayId: String = "",
) {
    private val normalizedHost get() = host.trim().lowercase(Locale.ROOT)
    private val normalizedRelayId get() = relayId.trim()

    val requiresPairingCode: Boolean
        get() = when (mode) {
            ConnectionMode.BROKER -> true
            ConnectionMode.DIRECT -> isPrivateLanHost(normalizedHost)
        }

    /** LAN = unencrypted local HTTP; TAILSCALE/BROKER are encrypted transports. */
    val transportLabel: String
        get() = when (mode) {
            ConnectionMode.BROKER -> "VPS"
            ConnectionMode.DIRECT ->
                if (isPrivateLanHost(normalizedHost)) "LAN" else "TAILSCALE"
        }

    fun validate(): String? = when (mode) {
        ConnectionMode.DIRECT -> when {
            !isAllowedRelayHost(normalizedHost) ->
                "Direct mode needs a Tailscale host (*.ts.net / 100.x) or a private LAN address"
            port !in 1..65535 -> "Invalid port"
            scheme.lowercase() !in listOf("http", "https") -> "Invalid scheme"
            else -> null
        }
        ConnectionMode.BROKER -> when {
            normalizedRelayId.isEmpty() -> "Relay ID is required"
            else -> try {
                val u = URL(brokerBaseUrl.trim())
                val s = u.protocol.lowercase()
                val local = u.host.lowercase() in listOf("localhost", "127.0.0.1", "::1")
                if (s !in listOf("https", "wss") && !(local && s in listOf("http", "ws"))) {
                    "Server mode requires an HTTPS URL"
                } else null
            } catch (_: Exception) {
                "Invalid server URL"
            }
        }
    }

    fun baseHttp(): String = when (mode) {
        ConnectionMode.DIRECT -> "$scheme://$normalizedHost:$port"
        ConnectionMode.BROKER -> {
            var b = brokerBaseUrl.trim().removeSuffix("/")
            if (b.startsWith("wss://")) b = "https://" + b.removePrefix("wss://")
            if (b.startsWith("ws://")) b = "http://" + b.removePrefix("ws://")
            b
        }
    }

    fun healthUrl() = "${baseHttp()}/v1/health"
    fun stateUrl() = "${baseHttp()}/v1/state"
    fun registerUrl() = "${baseHttp()}/v1/devices/me/register"

    fun webSocketUrl(): String = when (mode) {
        ConnectionMode.DIRECT -> {
            val wsScheme = if (scheme.lowercase() == "https") "wss" else "ws"
            "$wsScheme://$normalizedHost:$port/v1/ws"
        }
        ConnectionMode.BROKER -> {
            var b = brokerBaseUrl.trim().removeSuffix("/")
            if (b.startsWith("https://")) b = "wss://" + b.removePrefix("https://")
            if (b.startsWith("http://")) b = "ws://" + b.removePrefix("http://")
            "$b/v1/ws?relay_id=${Uri.encode(normalizedRelayId)}"
        }
    }

    /** Stable identity used to key stored credentials. */
    fun credentialKey(): String = when (mode) {
        ConnectionMode.DIRECT -> "direct|$scheme://$normalizedHost:$port"
        ConnectionMode.BROKER -> "broker|${baseHttp()}|$normalizedRelayId"
    }

    companion object {
        fun isPrivateLanHost(host: String): Boolean {
            val h = host.trim().lowercase(Locale.ROOT)
            if (h.endsWith(".local")) return h.length > ".local".length
            val parts = h.split(".")
            if (parts.size != 4) return false
            val octets = parts.map { it.toIntOrNull() ?: return false }
            if (octets.any { it !in 0..255 }) return false
            return when (octets[0]) {
                10 -> true
                172 -> octets[1] in 16..31
                192 -> octets[1] == 168
                169 -> octets[1] == 254
                else -> false
            }
        }

        fun isAllowedRelayHost(host: String): Boolean {
            val h = host.trim().lowercase(Locale.ROOT)
            if (h.isEmpty()) return false
            if (h == "localhost" || h == "127.0.0.1") return true
            if (h.endsWith(".ts.net")) return true
            if (isPrivateLanHost(h)) return true
            val parts = h.split(".")
            if (parts.size == 4) {
                val o = parts.mapNotNull { it.toIntOrNull() }
                if (o.size == 4 && o.all { it in 0..255 }) {
                    return o[0] == 100 && o[1] in 64..127
                }
            }
            return false
        }
    }
}

/** Decoded `cmux://pair?...` payload (same fields as iOS PairingPayload). */
data class PairingPayload(
    val serverUrl: String,
    val relayId: String,
    val pairingCode: String,
    val lanUrl: String?,
    val lanPairingCode: String?,
) {
    companion object {
        fun parse(raw: String): PairingPayload? {
            val uri = try { Uri.parse(raw.trim()) } catch (_: Exception) { return null }
            if (uri.scheme?.lowercase() != "cmux" || uri.host?.lowercase() != "pair") return null
            val server = uri.getQueryParameter("server") ?: return null
            val relay = uri.getQueryParameter("relay") ?: return null
            val code = uri.getQueryParameter("code") ?: return null
            val lan = uri.getQueryParameter("lan")
            val lanCode = uri.getQueryParameter("lancode")
            return PairingPayload(
                serverUrl = server,
                relayId = relay,
                pairingCode = code,
                lanUrl = if (!lan.isNullOrEmpty() && !lanCode.isNullOrEmpty()) lan else null,
                lanPairingCode = if (!lan.isNullOrEmpty() && !lanCode.isNullOrEmpty()) lanCode else null,
            )
        }

        /** Host/port/scheme embedded in a `lan` URL like http://192.168.1.5:4399. */
        fun lanEndpoint(lanUrl: String): RelayEndpoint? {
            val uri = try { Uri.parse(lanUrl.trim()) } catch (_: Exception) { return null }
            val host = uri.host ?: return null
            val scheme = uri.scheme?.lowercase()?.takeIf { it == "http" || it == "https" } ?: "http"
            return RelayEndpoint(
                mode = ConnectionMode.DIRECT,
                host = host,
                port = if (uri.port > 0) uri.port else 4399,
                scheme = scheme,
            )
        }
    }
}
