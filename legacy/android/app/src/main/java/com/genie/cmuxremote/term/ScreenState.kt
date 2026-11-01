package com.genie.cmuxremote.term

import com.genie.cmuxremote.net.DiffOp
import com.genie.cmuxremote.net.PushFrame
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest

/**
 * The mirrored terminal grid: raw ANSI rows + cursor + rev, updated by
 * screen.full / screen.diff push frames and verified against
 * screen.checksum (SHA-256, same construction as SharedKit ScreenHasher).
 */
class ScreenState {
    var rows: List<String> = emptyList()
        private set
    var cols: Int = 80
        private set
    var rev: Int = 0
        private set
    var cursorX: Int = 0
        private set
    var cursorY: Int = 0
        private set

    fun reset() {
        rows = emptyList()
        cols = 80
        rev = 0
        cursorX = 0
        cursorY = 0
    }

    fun applyFull(f: PushFrame.ScreenFull) {
        cols = f.cols
        val target = if (f.rowsCount > 0) f.rowsCount else f.rows.size
        val list = f.rows.toMutableList()
        while (list.size < target) list.add("")
        rows = list
        cursorX = f.cursorX
        cursorY = f.cursorY
        rev = f.rev
    }

    fun setFromText(text: String, newRev: Int) {
        val split = text.split("\n")
        rows = if (split.isEmpty()) listOf("") else split
        cols = rows.maxOf { visibleLength(it) }
        cursorX = 0
        cursorY = 0
        rev = newRev
    }

    fun applyDiff(f: PushFrame.ScreenDiff) {
        val list = rows.toMutableList()
        for (op in f.ops) {
            when (op) {
                is DiffOp.Clear -> for (i in list.indices) list[i] = ""
                is DiffOp.Row -> {
                    while (list.size <= op.y) list.add("")
                    list[op.y] = op.text
                }
                is DiffOp.Cursor -> {
                    cursorX = op.x
                    cursorY = op.y
                }
            }
        }
        rows = list
        rev = f.rev
    }

    fun checksumMatches(hash: String): Boolean = checksum() == hash

    /** SHA-256 over rows (each + \n), then 0xFF, then cursor x/y as LE int64. */
    fun checksum(): String {
        val md = MessageDigest.getInstance("SHA-256")
        for (row in rows) {
            md.update(row.toByteArray(Charsets.UTF_8))
            md.update(0x0A)
        }
        md.update(0xFF.toByte())
        val buf = ByteBuffer.allocate(16).order(ByteOrder.LITTLE_ENDIAN)
        buf.putLong(cursorX.toLong())
        buf.putLong(cursorY.toLong())
        md.update(buf.array())
        return md.digest().take(8).joinToString("") { "%02x".format(it) }
    }

    companion object {
        /** Length in characters ignoring ANSI escape sequences. */
        fun visibleLength(s: String): Int = AnsiParser.parseCells(s).size
    }
}
