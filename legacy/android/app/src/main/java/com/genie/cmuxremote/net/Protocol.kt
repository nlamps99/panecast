package com.genie.cmuxremote.net

import org.json.JSONArray
import org.json.JSONObject

/** Diff ops carried by `screen.diff` push frames. Mirrors SharedKit DiffOp. */
sealed interface DiffOp {
    data class Row(val y: Int, val text: String) : DiffOp
    data class Cursor(val x: Int, val y: Int) : DiffOp
    data object Clear : DiffOp
}

/** Server-pushed frames on /v1/ws, discriminated by the `type` field. */
sealed interface PushFrame {
    data class ScreenFull(
        val surfaceId: String,
        val rev: Int,
        val rows: List<String>,
        val cols: Int,
        val rowsCount: Int,
        val cursorX: Int,
        val cursorY: Int,
    ) : PushFrame

    data class ScreenDiff(val surfaceId: String, val rev: Int, val ops: List<DiffOp>) : PushFrame

    data class ScreenChecksum(val surfaceId: String, val rev: Int, val hash: String) : PushFrame

    data class Event(val category: String, val name: String, val payload: JSONObject?) : PushFrame

    data class Ping(val ts: Long) : PushFrame
    data class Pong(val ts: Long) : PushFrame

    companion object {
        fun parse(text: String): PushFrame? {
            val o = try {
                JSONObject(text)
            } catch (_: Exception) {
                return null
            }
            return try {
                when (o.optString("type")) {
                    "screen.full" -> {
                        val rowsJson = o.optJSONArray("rows") ?: JSONArray()
                        val rows = (0 until rowsJson.length()).map { rowsJson.optString(it, "") }
                        val cursor = o.optJSONObject("cursor")
                        ScreenFull(
                            surfaceId = o.optString("surface_id"),
                            rev = o.optInt("rev"),
                            rows = rows,
                            cols = o.optInt("cols"),
                            rowsCount = o.optInt("rowsCount", rows.size),
                            cursorX = cursor?.optInt("x") ?: 0,
                            cursorY = cursor?.optInt("y") ?: 0,
                        )
                    }
                    "screen.diff" -> {
                        val opsJson = o.optJSONArray("ops") ?: JSONArray()
                        val ops = (0 until opsJson.length()).mapNotNull { i ->
                            val op = opsJson.optJSONObject(i) ?: return@mapNotNull null
                            when (op.optString("op")) {
                                "row" -> DiffOp.Row(op.optInt("y"), op.optString("text", ""))
                                "cursor" -> DiffOp.Cursor(op.optInt("x"), op.optInt("y"))
                                "clear" -> DiffOp.Clear
                                else -> null
                            }
                        }
                        ScreenDiff(o.optString("surface_id"), o.optInt("rev"), ops)
                    }
                    "screen.checksum" -> ScreenChecksum(
                        o.optString("surface_id"), o.optInt("rev"), o.optString("hash")
                    )
                    "event" -> Event(
                        category = o.optString("category", "unknown"),
                        name = o.optString("name", ""),
                        payload = o.optJSONObject("payload"),
                    )
                    "ping" -> Ping(o.optLong("ts"))
                    "pong" -> Pong(o.optLong("ts"))
                    else -> null
                }
            } catch (_: Exception) {
                null
            }
        }
    }
}

/** Result of one RPC call. `error` is non-null when the relay/cmux reported failure. */
data class RpcResult(
    val ok: Boolean,
    val result: Any?,   // JSONObject / JSONArray / primitive / null
    val errorCode: String?,
    val errorMessage: String?,
)

class RpcException(val code: String, message: String) : Exception(message)

fun rpcParams(vararg pairs: Pair<String, Any?>): JSONObject {
    val o = JSONObject()
    for ((k, v) in pairs) {
        when (v) {
            null -> o.put(k, JSONObject.NULL)
            is JSONObject, is JSONArray -> o.put(k, v)
            else -> o.put(k, v)
        }
    }
    return o
}

fun JSONObject?.optStringOrNull(key: String): String? {
    if (this == null || !has(key) || isNull(key)) return null
    return optString(key).takeIf { it.isNotEmpty() }
}

/** Collects every string leaf of an arbitrary JSON tree. */
fun Any?.stringLeaves(): List<String> {
    val out = mutableListOf<String>()
    fun walk(v: Any?) {
        when (v) {
            is String -> if (v.isNotEmpty()) out.add(v)
            is JSONArray -> for (i in 0 until v.length()) walk(v.opt(i))
            is JSONObject -> for (k in v.keys()) walk(v.opt(k))
            else -> {}
        }
    }
    walk(this)
    return out
}
